# Developer commands. `make` lists them.
.DEFAULT_GOAL := help
.PHONY: help setup server web web-fixtures web-test web-e2e web-eval app app-dev test lint fmt check swift-check fixture eval clean

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

BASELINE := data/eval/baseline-macos
WEB_EVAL_RUN := data/eval/web-reports/$(shell date +%Y%m%d-%H%M%S)

web-eval: web/node_modules ## Run the eval in Chrome (~35 min) and print it next to the macOS baseline
	@test -f $(BASELINE)/report.json || { echo "No macOS baseline. Run 'make eval', then copy its data/eval/reports/<run>/ files to $(BASELINE)/"; exit 1; }
	$(UV) python scripts/eval/web_eval.py prepare --clips 100
	cd web && node eval/run.ts --inputs ../data/eval/web-inputs --out ../$(WEB_EVAL_RUN)/rows.json
	$(UV) python scripts/eval/web_eval.py score --rows $(WEB_EVAL_RUN)/rows.json
	@printf '\nmacOS baseline\n'; cat $(BASELINE)/report.md
	@printf '\nweb, Chrome on WebGPU\n'; cat $(WEB_EVAL_RUN)/report.md
	@printf '\nweb against the baseline\n'
	$(UV) python scripts/eval/compare_reports.py $(BASELINE)/report.json $(WEB_EVAL_RUN)/report.json

clean: ## Remove build output and caches
	rm -rf dist build .pytest_cache .ruff_cache
	find src tests scripts -name __pycache__ -type d -prune -exec rm -rf {} +
