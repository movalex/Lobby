-- Lobby's own database and login role on a shared Azure Database for PostgreSQL Flexible Server (dbcpsql).
-- docs/AZURE-INSTALL-AGENT.md, phase D. Run ONCE, by a person with the server's admin login, from a machine
-- inside the server's network (the main VM), with psql 15 or newer:
--
--   export LOBBY_DB_PASSWORD="$(...from Key Vault...)"   # never typed into argv or chat
--   psql "host=<server>.postgres.database.azure.com port=5432 dbname=postgres user=<admin> sslmode=verify-full" \
--     -f create-lobby-db.sql
--
-- Tested on PostgreSQL 16.15 as a non-superuser admin with CREATEDB and CREATEROLE (as Azure's admin is).
-- The api creates every table itself (packages/db/migrations, run at start-up): this only makes the empty
-- database it owns. No extension and no superuser right is needed.

\set ON_ERROR_STOP on
\getenv lobby_pw LOBBY_DB_PASSWORD
\if :{?lobby_pw}
\else
  \echo 'LOBBY_DB_PASSWORD is not set'
  \quit
\endif

-- CONNECTION LIMIT 8: the api's pool (DRAFTROOM_DB_POOL_MAX=5), its health probe (1), a one-off CLI (1) and one
-- spare. A runaway Lobby then fails on its own connections instead of using up the slots the server's other
-- applications share.
CREATE ROLE lobby LOGIN PASSWORD :'lobby_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 8;

-- Since PostgreSQL 16 a CREATEROLE admin may give a database to a role only when it can SET ROLE to it.
GRANT lobby TO CURRENT_USER;

-- The server's default template (UTF8, en_US.utf8 on dbcpsql). The api's tests store emoji: UTF8 is required.
CREATE DATABASE lobby OWNER lobby ENCODING 'UTF8';
REVOKE ALL ON DATABASE lobby FROM PUBLIC;

SELECT datname, pg_encoding_to_char(encoding) AS encoding, datcollate, pg_get_userbyid(datdba) AS owner
  FROM pg_database WHERE datname = 'lobby';
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolconnlimit FROM pg_roles WHERE rolname = 'lobby';
