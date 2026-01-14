# NAS 部署指南

## 问题说明

NAS 上使用 bind mount (直接挂载主机目录) 可能会遇到权限问题,因为:
- NAS 通常使用 NFS、CIFS/SMB 等网络文件系统
- 这些文件系统不完全支持 Unix 权限管理
- `chown` 命令可能失败或被忽略

## 解决方案:使用 Docker Named Volumes

### 1. 使用 NAS 专用配置文件

```bash
# 在 NAS 上使用这个配置文件
docker-compose -f docker-compose.nas.yml up -d
```

### 2. 配置说明

`docker-compose.nas.yml` 使用 named volumes 而不是 bind mounts:

```yaml
volumes:
  - storage-data:/var/www/html/storage   # Docker 管理的 volume
  - uploads-data:/var/www/html/uploads   # Docker 管理的 volume
```

**优点**:
- ✅ Docker 自动管理权限
- ✅ 兼容所有 NAS 文件系统
- ✅ 性能更好
- ✅ 数据持久化

**缺点**:
- ❌ 数据不直接在主机目录中可见
- ❌ 需要使用 Docker 命令查看/备份

### 3. 数据管理

#### 查看数据位置

```bash
docker volume ls
docker volume inspect siyuan-plugin-share_storage-data
```

#### 查看数据内容

```bash
# 查看 storage 数据
docker run --rm -v siyuan-plugin-share_storage-data:/data alpine ls -lah /data

# 查看数据库
docker run --rm -v siyuan-plugin-share_storage-data:/data alpine cat /data/app.db | wc -c
```

#### 备份数据

```bash
# 使用提供的备份脚本
./backup-volumes.sh
```

手动备份:
```bash
# 备份 storage
docker run --rm \
  -v siyuan-plugin-share_storage-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/storage-$(date +%Y%m%d).tar.gz -C /source .

# 备份 uploads  
docker run --rm \
  -v siyuan-plugin-share_uploads-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/uploads-$(date +%Y%m%d).tar.gz -C /source .
```

#### 恢复数据

```bash
# 恢复 storage
docker run --rm \
  -v siyuan-plugin-share_storage-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cd /target && tar xzf /backup/storage-20260114.tar.gz"

# 恢复 uploads
docker run --rm \
  -v siyuan-plugin-share_uploads-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cd /target && tar xzf /backup/uploads-20260114.tar.gz"
```

### 4. 迁移现有数据 (如果有)

如果你之前使用 bind mount 并且已有数据:

```bash
# 1. 停止服务
docker-compose down

# 2. 备份现有数据
cp -r php-site/storage backups/storage-old
cp -r php-site/uploads backups/uploads-old

# 3. 使用新配置启动
docker-compose -f docker-compose.nas.yml up -d

# 4. 复制数据到 volume
docker run --rm \
  -v siyuan-plugin-share_storage-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cp -r /backup/storage-old/* /target/"

docker run --rm \
  -v siyuan-plugin-share_uploads-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cp -r /backup/uploads-old/* /target/"

# 5. 重启服务
docker-compose -f docker-compose.nas.yml restart
```

### 5. 定期备份设置

在 NAS 上设置定时任务:

**群晖 NAS**:
1. 控制面板 → 任务计划
2. 新增 → 自定义脚本
3. 设置每天运行
4. 脚本内容: `cd /volume1/docker/siyuan-plugin-share && ./backup-volumes.sh`

**QNAP**:
1. 控制台 → 系统 → 排程
2. 添加任务
3. 脚本: `cd /share/Container/siyuan-plugin-share && ./backup-volumes.sh`

## 快速部署步骤

```bash
# 1. 准备配置文件
cp php-site/config.example.php php-site/config.php

# 2. 使用 NAS 配置启动
docker-compose -f docker-compose.nas.yml up -d

# 3. 查看日志
docker-compose -f docker-compose.nas.yml logs -f

# 4. 访问应用
open http://your-nas-ip:8080
```

## 故障排查

### 如果还是有权限问题

尝试方案 2 - 修改 entrypoint 脚本,使其在容器内部创建 storage:

```bash
# 修改 docker-entrypoint.sh
# 如果 /var/www/html/storage 不可写,则使用容器内部目录
```

### 检查 Docker 版本

```bash
docker --version
docker-compose --version
```

确保 Docker 版本 >= 20.10

### 查看 volume 驱动

```bash
docker volume inspect siyuan-plugin-share_storage-data | grep Driver
```

应该显示 `"Driver": "local"`
