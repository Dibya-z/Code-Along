FROM python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
RUN pip install --no-cache-dir uv==0.10.9
COPY pyproject.toml uv.lock .python-version ./
COPY apps/api ./apps/api
RUN uv sync --locked --no-dev --no-python-downloads
RUN useradd --uid 10001 --create-home api
WORKDIR /app/apps/api
USER api
CMD ["/app/.venv/bin/daphne", "-b", "0.0.0.0", "-p", "8000", "config.asgi:application"]
