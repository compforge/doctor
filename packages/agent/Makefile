.PHONY: fix lint lint-ci test
TEST_FILES ?=

fix:
	@true

lint:
	bun run typecheck

lint-ci: lint

test:
	bun test $(if $(strip $(TEST_FILES)),$(TEST_FILES),tests)
