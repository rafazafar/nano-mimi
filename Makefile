# Developer commands. `make` lists them.
.DEFAULT_GOAL := help
.PHONY: help setup server web web-fixtures web-test web-e2e app app-dev test lint fmt check swift-check fixture eval clean

UV := uv run

help: ## List commands
	@awk 'BEGIN{FS=":.*## "} /^[a-z-]+:.*## /{printf "  make %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Install Python deps (incl. dev tools) into .venv
	@command -v uv >/dev/null || { echo "Install uv first: brew install uv"; exit 1; }
	@command -v ffmpeg >/dev/null || echo "note: ffmpeg not found (brew install ffmpeg); needed for non-WAV input"
	uv sync --extra dev

server: ## Run the local API (requires MIMIVOX_API_TOKEN)
	$(UV) mimivox-server

app: ## Build dist/MimiVox.app and open it (needs Xcode 26+)
	scripts/build_app.sh
	open dist/MimiVox.app

app-dev: ## Run the SwiftUI app and local helper from source
	cd macos/MeetingTranslator && swift run MeetingTranslator

test: ## Run the Python tests
	$(UV) pytest

lint: ## Check Python style
	$(UV) ruff check
	$(UV) ruff format --check

fmt: ## Fix Python style
	$(UV) ruff check --fix
	$(UV) ruff format

swift-check: ## Build the Swift app and run its checks
	cd macos/MeetingTranslator && swift build && swift run MeetingTranslatorCoreChecks

check: lint test ## Lint + tests (run before a PR)

fixture: ## Generate the sample meeting recording for Replay
	$(UV) python scripts/make_meeting_fixture.py

web/node_modules: web/package-lock.json
	cd web && npm ci
	touch web/node_modules

web: web/node_modules ## Run the browser app dev server
	cd web && npm run dev

web-fixtures: ## Regenerate web/fixtures from the Python functions (needs the CAT model cache)
	$(UV) python scripts/export_web_fixtures.py

web-test: web/node_modules ## Typecheck and replay fixtures in vitest
	cd web && npm run typecheck && npm test

web-e2e: web/node_modules ## Open the shell in Chrome and check the WebGPU adapter
	cd web && npm run test:e2e

eval: ## Run the eval harness (~20 min; see docs/eval.md)
	$(UV) python scripts/eval/fetch_fleurs.py
	$(UV) python scripts/eval/build_meetings.py -n 5
	$(UV) python scripts/eval/run_eval.py --clips 100

clean: ## Remove build output and caches
	rm -rf dist build .pytest_cache .ruff_cache
	find src tests scripts -name __pycache__ -type d -prune -exec rm -rf {} +
