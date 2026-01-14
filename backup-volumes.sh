#!/bin/bash
# 备份 Docker volume 数据的脚本

# 配置
CONTAINER_NAME="siyuan-share-web"
BACKUP_DIR="./backups"
DATE=$(date +%Y%m%d-%H%M%S)

# 创建备份目录
mkdir -p "$BACKUP_DIR"

echo "开始备份 storage 数据..."
docker run --rm \
  -v siyuan-plugin-share_storage-data:/source:ro \
  -v "$(pwd)/$BACKUP_DIR":/backup \
  alpine tar czf "/backup/storage-$DATE.tar.gz" -C /source .

echo "开始备份 uploads 数据..."
docker run --rm \
  -v siyuan-plugin-share_uploads-data:/source:ro \
  -v "$(pwd)/$BACKUP_DIR":/backup \
  alpine tar czf "/backup/uploads-$DATE.tar.gz" -C /source .

echo "备份完成!"
echo "Storage 备份: $BACKUP_DIR/storage-$DATE.tar.gz"
echo "Uploads 备份: $BACKUP_DIR/uploads-$DATE.tar.gz"

# 清理 7 天前的备份
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +7 -delete
echo "已清理 7 天前的旧备份"
