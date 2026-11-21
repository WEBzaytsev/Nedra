override SHELL := /bin/bash

COMPOSE_PROD := docker compose -f docker-compose.prod.yml

.PHONY: all
all: clean dev



.PHONY: dev
dev:
	@echo 'Starting the dev stack with hot-reload (UI :3000, API :8000)...'
	docker compose up -d --build

.PHONY: down
down:
	@echo 'Stopping the dev stack (vault volume is kept)...'
	docker compose down

.PHONY: clean
clean:
	@echo 'Removing the dev stack and its vault volume...'
	-docker compose down --volumes --remove-orphans --rmi local
	@echo 'Removing cache files...'
	-find . -type f -name '*.py[co]' -delete -o -type d -name __pycache__ -delete



.PHONY: prod-up
prod-up:
	@echo 'Pulling and starting the production stack from GHCR images...'
	$(COMPOSE_PROD) up -d

.PHONY: prod-snapshot
prod-snapshot:
	@echo 'Writing a consistent snapshot of the real vault into its volume...'
	$(COMPOSE_PROD) exec backend nedra-admin snapshot

.PHONY: prod-down
prod-down:
	@echo 'Stopping the production stack (vault volume is kept)...'
	$(COMPOSE_PROD) down

.PHONY: clean-prod
clean-prod:
	@echo 'WARNING: this DESTROYS the production vault volume -> your real vault.'
	@echo 'There is no password recovery. This cannot be undone.'
	@read -r -p 'Type "destroy" to confirm: ' ans; \
	if [ "$$ans" = "destroy" ]; then \
		$(COMPOSE_PROD) down --volumes --remove-orphans; \
		echo 'Production stack and volume removed.'; \
	else \
		echo 'Aborted. Nothing was removed.'; \
	fi



.PHONY: release release-dry
release:
	@test -n "$(VERSION)" || { echo 'usage: make release VERSION=X.Y.Z'; exit 1; }
	@scripts/release.sh "$(VERSION)"

release-dry:
	@test -n "$(VERSION)" || { echo 'usage: make release-dry VERSION=X.Y.Z'; exit 1; }
	@scripts/release.sh "$(VERSION)" --dry-run

.PHONY: lint
lint:
	cd backend && uv run ruff check .
	cd frontend && npm run lint

.PHONY: typecheck
typecheck:
	cd backend && uv run ty check .

.PHONY: format
format:
	cd backend && uv run ruff format .
	cd frontend && npm run format

.PHONY: check
check:
	cd backend && uv run ruff check . && uv run ruff format --check . && uv run ty check .
	cd frontend && npm run lint && npm run format:check


.PHONY: desktop-setup desktop-dev desktop-build desktop-check
desktop-setup:
	python3 desktop/dev_setup.py
	cd frontend && npm ci
	cd desktop && npm ci

desktop-dev: desktop-setup
	cd desktop && npm run tauri dev -- --config tauri.dev.json

desktop-build:
	python3 desktop/core/build_core.py --python 3.13.15
	cd frontend && npm ci
	cd desktop && npm ci && npm run tauri build -- --bundles app

desktop-check:
	cd desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
	cd backend && uv run ruff check ../desktop --exclude build --exclude dist --exclude target
