"""Certificate preservation, explicit trust boundaries and real loopback TLS checks."""

import os
import shutil
import signal
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.dev import local_tls as module


@pytest.fixture(scope="module")
def signed_files(tmp_path_factory):
    root = tmp_path_factory.mktemp("tls-fixture")
    authority = root / ".runtime/local-ca"
    certificates = root / ".runtime/certs"
    authority.mkdir(parents=True)
    certificates.mkdir()

    def run(arguments):
        subprocess.run(["openssl", *arguments], capture_output=True, check=True)

    run(
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "365",
            "-subj",
            "/CN=Code Along disposable test CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-out",
            str(authority / "rootCA.pem"),
            "-keyout",
            str(authority / "rootCA-key.pem"),
        ]
    )
    run(
        [
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=Code Along TLS test",
            "-out",
            str(root / "leaf.csr"),
            "-keyout",
            str(certificates / "key.pem"),
        ]
    )
    extensions = root / "leaf.ext"
    extensions.write_text(
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"
    )
    run(
        [
            "x509",
            "-req",
            "-in",
            str(root / "leaf.csr"),
            "-CA",
            str(authority / "rootCA.pem"),
            "-CAkey",
            str(authority / "rootCA-key.pem"),
            "-CAcreateserial",
            "-days",
            "90",
            "-extfile",
            str(extensions),
            "-out",
            str(certificates / "cert.pem"),
        ]
    )
    return root


@pytest.fixture
def workspace(tmp_path, signed_files):
    shutil.copytree(signed_files / ".runtime", tmp_path / ".runtime")
    return tmp_path


def test_real_certificate_validation_rejects_expiry_names_and_mismatched_keys(
    workspace, monkeypatch
):
    certs = workspace / ".runtime/certs"
    module.validate(workspace, certs)
    monkeypatch.setattr(module, "RENEW_BEFORE", 91 * 24 * 60 * 60)
    with pytest.raises(module.DevelopmentError):
        module.validate(workspace, certs)
    monkeypatch.setattr(module, "RENEW_BEFORE", 30 * 24 * 60 * 60)
    monkeypatch.setattr(module, "HOSTS", ("192.0.2.1", "wrong.example.test"))
    with pytest.raises(module.DevelopmentError):
        module.validate(workspace, certs)
    shutil.copy2(workspace / ".runtime/local-ca/rootCA-key.pem", certs / "key.pem")
    with pytest.raises(ssl.SSLError):
        module.validate(workspace, certs)


def test_setup_is_idempotent_and_preserves_credentials_without_trust(
    workspace, monkeypatch
):
    env = workspace / ".env"
    env.write_text("private test placeholder\n")
    before = {p: p.read_bytes() for p in (workspace / ".runtime").rglob("*.pem")}
    monkeypatch.setattr(module, "require_stopped", lambda root: None)
    monkeypatch.setattr(module, "mkcert", lambda root: "must-not-execute-mkcert")
    module.setup(workspace)
    assert {p: p.read_bytes() for p in before} == before
    assert env.read_text() == "private test placeholder\n"
    assert not list((workspace / ".runtime").glob("tls-backup-*"))


def generation_fixture(workspace, monkeypatch):
    generated = {
        name: (workspace / ".runtime/certs" / name).read_bytes()
        for name in ("cert.pem", "key.pem")
    }
    original = module.command
    calls = []

    def command(arguments, *, root):
        calls.append(arguments)
        if arguments[0] == "fixture-mkcert":
            for flag, name in (("-cert-file", "cert.pem"), ("-key-file", "key.pem")):
                Path(arguments[arguments.index(flag) + 1]).write_bytes(generated[name])
            return ""
        return original(arguments, root=root)

    monkeypatch.setattr(module, "command", command)
    monkeypatch.setattr(module, "require_stopped", lambda root: None)
    monkeypatch.setattr(module, "mkcert", lambda root: "fixture-mkcert")
    old = {"cert.pem": b"previous certificate", "key.pem": b"previous key"}
    for name, value in old.items():
        (workspace / ".runtime/certs" / name).write_bytes(value)
    return calls, old, generated


def test_setup_backs_up_both_files_and_never_installs_trust(workspace, monkeypatch):
    calls, old, generated = generation_fixture(workspace, monkeypatch)
    module.setup(workspace)
    (backup,) = (workspace / ".runtime").glob("tls-backup-*")
    for name in old:
        assert (backup / name).read_bytes() == old[name]
        assert (workspace / ".runtime/certs" / name).read_bytes() == generated[name]
        assert (workspace / ".runtime/certs" / name).stat().st_mode & 0o777 == 0o600
    assert not list((workspace / ".runtime").glob("tls-pending-*"))
    assert not any("-install" in call or "-uninstall" in call for call in calls)
    assert calls[0][-2:] == ["127.0.0.1", "localhost"]


@pytest.mark.parametrize("failure", ["generation", "validation", "replacement"])
def test_setup_failure_preserves_or_restores_the_original_pair(
    workspace, monkeypatch, failure
):
    calls, old, _ = generation_fixture(workspace, monkeypatch)
    if failure == "generation":

        def fail(*args, **kwargs):
            raise module.DevelopmentError("fixture generation failure")

        monkeypatch.setattr(module, "command", fail)
    elif failure == "validation":

        def fail(*args, **kwargs):
            raise module.DevelopmentError("fixture validation failure")

        monkeypatch.setattr(module, "validate", fail)
    else:
        replace = module.os.replace

        def fail(source, destination):
            if source.name == "key.pem":
                raise OSError("fixture replacement failure")
            replace(source, destination)

        monkeypatch.setattr(module.os, "replace", fail)
    with pytest.raises((module.DevelopmentError, OSError)):
        module.setup(workspace)
    for name, value in old.items():
        assert (workspace / ".runtime/certs" / name).read_bytes() == value
    assert not any("-install" in call for call in calls)


def test_setup_rejects_running_controller_before_any_certificate_changes(workspace):
    with module.controller_lock(workspace):
        with pytest.raises(module.DevelopmentError, match="already running"):
            module.setup(workspace)


@pytest.mark.parametrize("missing", ["cert.pem", "key.pem"])
def test_setup_does_not_overwrite_an_incomplete_pair(workspace, monkeypatch, missing):
    monkeypatch.setattr(module, "require_stopped", lambda root: None)
    monkeypatch.setattr(module, "mkcert", lambda root: "must-not-execute")
    (workspace / ".runtime/certs" / missing).unlink()
    with pytest.raises(module.DevelopmentError, match="Incomplete"):
        module.setup(workspace)


def test_mkcert_cannot_inherit_a_different_ca_or_additional_trust_stores(
    workspace, monkeypatch
):
    calls = []
    monkeypatch.setenv("CAROOT", "/must-not-use")
    monkeypatch.setenv("TRUST_STORES", "system,nss,java")
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: (
            calls.append((args, kwargs)) or SimpleNamespace(returncode=0, stdout="")
        ),
    )
    module.command(["fixture-mkcert", "localhost"], root=workspace)
    options = calls[0][1]
    assert options["env"]["CAROOT"] == str(workspace / ".runtime/local-ca")
    assert options["env"]["TRUST_STORES"] == "system"
    assert options["umask"] == 0o077


def test_trust_is_review_only_unless_install_or_uninstall_is_explicit(
    workspace, monkeypatch
):
    calls = []
    real_run = subprocess.run
    monkeypatch.setattr(module, "mkcert", lambda root: "fixture-mkcert")

    def run(arguments, **kwargs):
        if arguments[0] == "fixture-mkcert":
            calls.append((arguments, kwargs))
            return SimpleNamespace(returncode=0)
        return real_run(arguments, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", run)
    module.trust(workspace)
    assert not calls
    module.trust(workspace, action="-install")
    module.trust(workspace, action="-uninstall")
    assert [call[0] for call in calls] == [
        ["fixture-mkcert", "-install"],
        ["fixture-mkcert", "-uninstall"],
    ]
    assert all(call[1]["env"]["TRUST_STORES"] == "system" for call in calls)
    assert all("capture_output" not in call[1] for call in calls)


def test_install_flag_cannot_be_used_during_setup_or_check(monkeypatch):
    monkeypatch.setattr("sys.argv", ["local_tls", "setup", "--install"])
    with pytest.raises(SystemExit) as error:
        module.main()
    assert error.value.code == 2


@pytest.fixture
def tls_server(workspace, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(404 if self.path.startswith("/api/") else 200)
            self.end_headers()

        def log_message(self, *args):
            pass

    class Server(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            # The stale-certificate probe deliberately closes before an HTTP request.
            pass

    server = Server(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(
        workspace / ".runtime/certs/cert.pem", workspace / ".runtime/certs/key.pem"
    )
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        module, "app_origin", lambda root: f"https://127.0.0.1:{server.server_port}"
    )
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_preparation_refuses_an_active_https_listener(workspace, tls_server):
    with pytest.raises(module.DevelopmentError, match="npm run stop"):
        module.require_stopped(workspace)


@pytest.mark.parametrize("trusted", [False, True])
def test_actual_loopback_tls_and_os_trust_are_separate_gates(
    workspace, tls_server, monkeypatch, capsys, trusted
):
    monkeypatch.setattr(module.platform, "system", lambda: "Darwin")
    calls = []
    real_run = subprocess.run

    def run(arguments, **kwargs):
        if arguments[0] == "/usr/bin/security":
            calls.append(arguments)
            return SimpleNamespace(returncode=0 if trusted else 1)
        return real_run(arguments, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", run)
    if trusted:
        module.check(workspace)
    else:
        with pytest.raises(
            module.DevelopmentError, match="macOS trust is not verified"
        ):
            module.check(workspace)
    output = capsys.readouterr().out
    assert "Explicit-CA TLS" in output
    assert ("OS trust verified" in output) == trusted
    assert all("-r" not in call and "-N" not in call and "-L" in call for call in calls)
    assert [call[-1] for call in calls] == (
        ["127.0.0.1", "localhost"] if trusted else ["127.0.0.1"]
    )


def test_live_check_rejects_a_stale_served_certificate(
    workspace, tls_server, monkeypatch
):
    monkeypatch.setattr(
        module, "fingerprint", lambda path: "not-the-served-certificate"
    )
    with pytest.raises(module.DevelopmentError, match="old/different certificate"):
        module.check(workspace)


def test_other_unix_trust_check_uses_curl_defaults_without_ca_or_config_bypass(
    workspace, tls_server, monkeypatch
):
    monkeypatch.setattr(module.platform, "system", lambda: "Linux")
    for name in ("CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        monkeypatch.setenv(name, "/must-not-trust-an-override")
    calls = []
    real_run = subprocess.run

    def run(arguments, **kwargs):
        if arguments[0] == "curl":
            calls.append((arguments, kwargs))
            return SimpleNamespace(returncode=0)
        return real_run(arguments, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", run)
    module.check(workspace)
    assert len(calls) == 2
    for arguments, options in calls:
        assert arguments[1] == "--disable"
        assert "--insecure" not in arguments and "--cacert" not in arguments
        assert not {"CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"}.intersection(
            options["env"]
        )


@pytest.mark.parametrize("stop_signal", [signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
@pytest.mark.parametrize("phase", ["replacement", "rollback"])
def test_termination_finishes_a_consistent_pair_and_cleans_up(
    workspace, stop_signal, phase
):
    candidates = workspace / "candidate"
    shutil.copytree(workspace / ".runtime/certs", candidates)
    for source, destination in (
        ("rootCA.pem", "cert.pem"),
        ("rootCA-key.pem", "key.pem"),
    ):
        shutil.copy2(
            workspace / ".runtime/local-ca" / source,
            workspace / ".runtime/certs" / destination,
        )
    original = {
        name: (workspace / ".runtime/certs" / name).read_bytes()
        for name in ("cert.pem", "key.pem")
    }
    script = """
import os, shutil, sys, time
from pathlib import Path
from tools.dev import local_tls as module
root, phase = Path(sys.argv[1]), sys.argv[2]
module.require_stopped = lambda root: None
module.mkcert = lambda root: 'fixture-mkcert'
command, replace, copy = module.command, os.replace, shutil.copy2
def generate(arguments, *, root):
    if arguments[0] != 'fixture-mkcert':
        return command(arguments, root=root)
    for flag, name in (('-cert-file', 'cert.pem'), ('-key-file', 'key.pem')):
        copy(root/'candidate'/name, Path(arguments[arguments.index(flag)+1]))
    return ''
module.command = generate
def pause():
    (root/'paused').touch()
    deadline = time.monotonic()+15
    while not (root/'release').exists():
        if time.monotonic()>deadline:
            raise TimeoutError('Fixture release timed out')
        time.sleep(.01)
def replace_file(source, destination):
    replace(source, destination)
    if phase=='replacement' and source.name=='cert.pem':
        pause()
    if phase=='rollback' and source.name=='key.pem':
        raise OSError('Fixture rollback trigger')
def restore_file(source, destination):
    result = copy(source, destination)
    if phase=='rollback' and source.parent.name.startswith('tls-backup-') and source.name=='cert.pem':
        pause()
    return result
module.os.replace, module.shutil.copy2 = replace_file, restore_file
module.setup(root)
"""
    project = Path(__file__).resolve().parents[2]
    child = subprocess.Popen(
        [sys.executable, "-c", script, str(workspace), phase],
        cwd=project,
        env={**os.environ, "PYTHONPATH": str(project)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 15
        while not (workspace / "paused").exists():
            assert child.poll() is None, (
                "TLS fixture exited before its replacement/rollback barrier"
            )
            assert time.monotonic() < deadline, (
                "TLS fixture failed to reach its barrier"
            )
            time.sleep(0.02)
        for _ in range(2):
            child.send_signal(stop_signal)
            time.sleep(0.05)
            assert child.poll() is None, "Termination interrupted an inconsistent pair"
        (workspace / "release").touch()
        status = child.wait(timeout=10)
        expected = (
            {-signal.SIGINT, 128 + signal.SIGINT}
            if stop_signal == signal.SIGINT
            else {128 + stop_signal}
        )
        assert status in expected
        certs = workspace / ".runtime/certs"
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(
            certs / "cert.pem", certs / "key.pem"
        )
        (backup,) = (workspace / ".runtime").glob("tls-backup-*")
        for name in original:
            assert (backup / name).read_bytes() == original[name]
            expected_bytes = (
                (candidates / name).read_bytes()
                if phase == "replacement"
                else original[name]
            )
            assert (certs / name).read_bytes() == expected_bytes
        assert not list((workspace / ".runtime").glob("tls-pending-*"))
        with module.controller_lock(workspace):
            pass
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.communicate()


def test_pair_update_defers_custom_handlers_and_restores_ignored_handlers():
    previous_term = signal.getsignal(signal.SIGTERM)
    previous_hup = signal.getsignal(signal.SIGHUP)
    calls = []

    def caller_handler(signum, frame):
        calls.append(signum)

    signal.signal(signal.SIGTERM, caller_handler)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        with module.finish_pair_update():
            assert signal.getsignal(signal.SIGHUP) == signal.SIG_IGN
            os.kill(os.getpid(), signal.SIGTERM)
            os.kill(os.getpid(), signal.SIGTERM)
            assert not calls
        assert calls == [signal.SIGTERM]
        assert signal.getsignal(signal.SIGTERM) is caller_handler
        assert signal.getsignal(signal.SIGHUP) == signal.SIG_IGN
        with pytest.raises(OSError, match="fixture"):
            with module.finish_pair_update():
                raise OSError("fixture")
        assert signal.getsignal(signal.SIGTERM) is caller_handler
        assert signal.getsignal(signal.SIGHUP) == signal.SIG_IGN
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGHUP, previous_hup)


def test_pair_update_refuses_worker_threads_before_replacement():
    errors = []

    def worker():
        try:
            with module.finish_pair_update():
                pytest.fail("Worker thread must not enter certificate replacement")
        except module.DevelopmentError as error:
            errors.append(str(error))

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(errors) == 1 and "main-thread CLI" in errors[0]
