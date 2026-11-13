# Optional trusted local HTTPS

**Owner decision: system-wide CA trust installation is deferred.** These tools are optional; installing trust is not a prerequisite for continuing development, using the isolated test fixtures or inspecting existing M1 screens. The current HTTPS app may still require a site-specific browser exception where supported. A warning-free ordinary browser session and future runner behavior have not been certified without the relevant browser checks. No HTTP profile was added, and this decision does not authorize changing the app/runner isolation architecture.

The current development profile uses **https://127.0.0.1:8443** and its separate-site Python runner uses **https://localhost:8443**. It retains the approved HTTPS/separate-site setup. A self-signed certificate encrypts traffic but does not establish browser trust, which causes the privacy warning.

Use [mkcert](https://github.com/FiloSottile/mkcert) for a local development CA and a server certificate with exactly those two names. The root npm commands separate certificate preparation from an explicit OS trust operation. `npm run dev` never installs trust, disables browser TLS checks or renews certificates silently. This is local development setup, not production TLS.

## Optional setup, when explicitly selected

Install mkcert if it is not already available. On macOS its documented package command is `brew install mkcert`. This workstation already has a checksum-verified Homebrew mkcert 1.4.4 binary under ignored `.runtime/tools/mkcert/`; no global package installation was performed. Other workstations use mkcert on PATH. OpenSSL and the pinned Python/uv prerequisites must also be available.

From the Code-Along repository root:

```sh
npm run stop
npm run tls:setup
npm run tls:trust
```

`tls:setup` requires the development controller and HTTPS listener to be stopped. It creates a project-local CA in ignored `.runtime/local-ca/`, generates and validates a server certificate/key in a private temporary directory, backs up any existing pair to `.runtime/tls-backup-*/`, and activates the validated files under `.runtime/certs/`. Existing credentials, database/mail volumes and unrelated certificates are untouched. Ordinary replacement failures restore the prior pair. During the brief main-thread replacement/rollback section, Ctrl+C, SIGTERM and SIGHUP are deferred until a matching pair is installed or restored. Repeated requests honor the first signal, temporary files/locks unwind, and caller handlers/ignored signals are restored. Default TERM/HUP requests exit with conventional shell status `128 + signal`; Ctrl+C retains its normal interrupt behavior. Generation/validation outside this section is not protected, so cancellation there may leave private staging files but does not activate a partial pair. Repeating setup preserves a valid certificate with more than 30 days remaining. Incomplete pairs are rejected rather than overwritten. SIGKILL, power loss or a filesystem failure that also prevents restoration still require recovering both files from a complete backup; the pair is not a general atomic filesystem transaction.

`tls:trust` without flags only displays the project CA's SHA-256 fingerprint and the scope of the proposed change. Verify that this is the local CA you intend to trust. Its private `rootCA-key.pem` can issue certificates for other names; never share it or add it to Git, build contexts or container mounts. Only the leaf certificate/key directory is mounted into the HTTPS proxy. The CA is separate from any existing default mkcert CA.

The following command is the **explicit owner-controlled trust change**. It is documented for later use and **must not be run as part of the current deferred setup** without a new owner instruction:

```sh
npm run tls:trust -- --install
```

On macOS mkcert requests administrator authorization and installs the CA into the **System keychain**, affecting system trust for users of the machine. This trusts the CA, not just the two names in this particular server certificate. `TRUST_STORES=system` restricts the operation to the system store; the helper does not request Java or separate Firefox/NSS store changes. Enter any authorization password directly in your own terminal or macOS prompt, never in chat. The helper does not capture it. The agent does not run this command as part of setup or startup.

Fully quit and reopen your browser, then start the app and check it from a second terminal:

```sh
npm run dev
# In a second terminal:
npm run tls:check
```

Open **https://127.0.0.1:8443**. Neither this address nor **https://localhost:8443** should show a certificate privacy warning after trust is correctly installed and the browser has restarted. Keep the app and runner hostnames distinct. No browser security flags or certificate-warning bypasses are part of this workflow.

## What verification establishes

`tls:check` validates the certificate/key pair, CA signature, both names, server purpose and the 30-day renewal window. It then connects to both loopback sites with explicit CA validation and hostname checking, compares the actual served certificate to the prepared file, checks application readiness and runner HTML, and confirms the runner rejects product APIs. An old certificate still loaded by the proxy fails this check; restart the app after setup.

These explicit-CA checks are separate from OS trust. On macOS the command also evaluates both names with `/usr/bin/security verify-cert` using the real OS trust store and no supplied root override. An untrusted CA produces a failing exit code even if the explicit-CA network checks passed. On other Unix systems the final check uses curl defaults, without a user curl config or CA environment overrides; browser stores can still differ. Confirm the certificate state in your actual restarted browser. Existing isolated browser fixtures deliberately use their own test TLS settings and do not prove that your browser trusts this CA.

Unit/integration coverage uses disposable OpenSSL CAs and real loopback TLS, with fake OS trust responses. Subprocess regressions send repeated real SIGINT/SIGTERM/SIGHUP requests after the first file replacement and during rollback, then verify a matching active pair, preserved backup, temporary cleanup and released lock. Tests never install or remove certificate trust. CI retains its disposable self-signed profile and does not alter the runner's system trust store. Trust installation and normal-browser verification are deferred operational checks for this optional workflow, not gates blocking M1 inspection or further authorized development. `tls:check` is expected to fail its OS-trust stage while the CA is not trusted; ordinary app readiness is checked separately.

## Renewal, removal and recovery

To renew a certificate within the 30-day window, stop the app, rerun `npm run tls:setup`, then restart. The same CA is retained, so renewing the leaf does not normally require another trust installation. An expiring/invalid CA is not silently replaced: remove its trust explicitly and retain its private files/backups before arranging a new CA. No background renewal service is added.

To undo this project's trust installation:

```sh
npm run tls:trust -- --uninstall
```

This removes the same project CA from the selected system trust store and retains its files and your app data. It does not remove unrelated CAs. Do not delete `.runtime/local-ca/` before removal: its public root certificate identifies the trust entry. Restart your browser after removing trust.

To recover the previous server certificate, stop the app, restore **both** `cert.pem` and `key.pem` from the same `.runtime/tls-backup-*` directory into `.runtime/certs/`, preserve private key permissions, and restart. Restoring the original self-signed pair restores its original browser warning too. `tls:check` intentionally requires the project-CA certificate, so use the ordinary development readiness check while an older self-signed pair is restored. Never restore or replace database/mail volumes to resolve a certificate problem.

mkcert documents [CAROOT and trust-store selection](https://github.com/FiloSottile/mkcert#changing-the-location-of-the-ca-files) and [CA removal](https://github.com/FiloSottile/mkcert/blob/v1.4.4/main.go). The current workstation tool came from the [Homebrew formula metadata](https://formulae.brew.sh/api/formula/mkcert.json); its bottle URL and verified SHA-256 are recorded privately in `.runtime/tools/mkcert/provenance.json`. Moving this repository does not move installed trust: retain the CA files, update the filesystem location and rerun checks rather than creating a new CA silently.
