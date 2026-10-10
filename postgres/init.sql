-- Runs once on first cluster init. Cluster is initialised with C collation (see docker-compose.yml);
-- the default "synapse" DB is created via POSTGRES_DB. We add the backend DB here.
CREATE DATABASE support_backend WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
