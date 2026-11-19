#!/bin/bash
# Daily SQLite backup — safe with WAL mode
# Run via cron: 0 3 * * * /opt/replai/deploy/backup.sh

set -euo pipefail
umask 027

DB_PATH="/opt/replai/data/replai.db"
BACKUP_DIR="/opt/replai/backups"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/replai_${TIMESTAMP}.db"

# WAL-safe backup using sqlite3 .backup command
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Compress
gzip "$BACKUP_FILE"

echo "[$(date -Iseconds)] Backup created: ${BACKUP_FILE}.gz"

# Delete backups older than retention period
find "$BACKUP_DIR" -name "replai_*.db.gz" -mtime +${RETENTION_DAYS} -delete

echo "[$(date -Iseconds)] Cleaned up backups older than ${RETENTION_DAYS} days"
