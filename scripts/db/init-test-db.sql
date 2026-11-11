-- Runs once, on first start of a fresh Postgres volume (docker-entrypoint-initdb.d).
-- Creates the separate database the pipeline's DB-backed tests use
-- (pipeline/tests/conftest.py → chalkboard_test). Tests create their own tables.
CREATE DATABASE chalkboard_test OWNER chalkboard;
