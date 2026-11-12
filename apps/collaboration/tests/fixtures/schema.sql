-- Disposable proof fixture, NOT a product migration. Django owns production DDL.
CREATE SCHEMA checkpoint_proof;
CREATE TABLE checkpoint_proof.document (
    document_id uuid PRIMARY KEY,
    generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    UNIQUE (document_id, generation)
);
CREATE TABLE checkpoint_proof.document_state (
    document_id uuid PRIMARY KEY,
    generation bigint NOT NULL,
    binary_state bytea NOT NULL CHECK (octet_length(binary_state) <= 1048576),
    durable_revision bigint NOT NULL CHECK (durable_revision >= 0),
    state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    FOREIGN KEY (document_id, generation)
        REFERENCES checkpoint_proof.document (document_id, generation)
);
CREATE TABLE checkpoint_proof.checkpoint_receipt (
    document_id uuid NOT NULL,
    generation bigint NOT NULL,
    client_session_id uuid NOT NULL,
    checkpoint_id uuid NOT NULL,
    observed_counter bigint NOT NULL CHECK (observed_counter BETWEEN 0 AND 9007199254740991),
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    durable_revision bigint NOT NULL CHECK (durable_revision > 0),
    state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (document_id, generation, client_session_id, checkpoint_id),
    FOREIGN KEY (document_id, generation)
        REFERENCES checkpoint_proof.document (document_id, generation)
);
CREATE ROLE checkpoint_writer LOGIN;
GRANT USAGE ON SCHEMA checkpoint_proof TO checkpoint_writer;
GRANT SELECT ON checkpoint_proof.document TO checkpoint_writer;
GRANT SELECT, INSERT, UPDATE ON checkpoint_proof.document_state TO checkpoint_writer;
GRANT SELECT, INSERT ON checkpoint_proof.checkpoint_receipt TO checkpoint_writer;
