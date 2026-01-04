# 思源分享（Siyuan Share）

这是一款免费的思源笔记分享插件，支持将笔记本或文档生成分享链接，并支持设置访问密码及有效期。

[中文](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README_zh_CN.md) | [English](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README.md)

## ✨ 使用方法

- **操作入口**：在文档树中右键点击笔记本或文档，选择进入插件菜单。菜单中包含以下功能：
    - 创建分享
    - 更新分享
    - 复制分享链接
    - 删除分享
- **分享管理**：进入插件设置页面，可以查看所有已生成的分享列表，并进行统一管理。

## ⚠️ 注意事项

- **更新机制**：如果您修改了文档或笔记本的内容，请使用 **“更新分享”** 功能。这样可以保持原有的分享链接不变，同时同步最新内容。
- **链接变动**：如果您选择“删除分享”后再次“创建分享”，系统将会生成一个新的分享链接，旧链接将失效。

## ⚙️ 插件配置

本插件依赖于服务端网站 [share.b0x.top](https://share.b0x.top) 进行数据传输。

1.  **配置步骤**：
    - 请前往网站注册账号。
    - 在网站中生成 **API Key**。
    - 将 API Key 填入插件设置中，即可完成插件与服务端的连接。
    - 配置完成后，分享操作即是将对应的文档/笔记本上传至服务端。

2.  **服务端说明**：
    - 目前 [share.b0x.top](https://share.b0x.top) 是作者提供的**公共**服务端网站，仅供功能演示与短期使用。
    - **清理策略**：受限于服务器带宽与存储成本，系统会对大文件执行定期清理策略。
    - **私有化建议**：对于有长期持久化存储需求的用户，强烈建议参考 [服务端网站搭建教程](https://ccnwc9xa9692.feishu.cn/wiki/MQCtwMtQaifPuak4zl3cIMCqnLx) 进行私有化部署。

## 📖 功能演示

### 1. 生成 API Key 并填入

![生成api key并填入](https://github.com/user-attachments/assets/40bb0a47-d3f5-48fc-a96b-acd46fc6287d)

### 2. 分享文档

![分享文档](https://github.com/user-attachments/assets/82a5be6a-9a3e-4153-92a5-85e180c12d0e)

### 3. 打开分享文档

![打开分享文档](https://github.com/user-attachments/assets/ba14f2b1-2bd0-4dfb-a32a-04ad1e7b5567)

## ☕ 支持作者

如果您认为这个项目不错，欢迎支持，这将会鼓励我持续更新，打造更好的工具~

<div align="center">
    <a href="https://github.com/b8l8u8e8/siyuan-plugin-share">
        <img src="https://img.shields.io/github/stars/b8l8u8e8/siyuan-plugin-share?style=for-the-badge&color=ffd700&label=%E7%BB%99%E4%B8%AAStar%E5%90%A7" alt="Github Star">
    </a>
</div>
<div align="center" style="margin-top: 40px;">
    <div style="display: flex; justify-content: center; align-items: center; gap: 30px;">
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/81d0a064-b760-4e97-9c9b-bf83f6cafc8a" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #07c160; object-fit: contain; display: inline-block;">
            <br/>
            <b style="color: #07c160; display: block; margin-top: 10px;">微信支付</b>
        </div>
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/9e1988d0-4016-4b8d-9ea6-ce8ff714ee17" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #1677ff; object-fit: contain; display: inline-block;">
            <br/>
            <b style="color: #1677ff; display: block; margin-top: 10px;">支付宝</b>
        </div>
    </div>
    <p style="margin-top: 20px;"><i>您的支持是我不断迭代的动力</i></p>
</div>

### 🛠️ 其他信息

- **问题反馈**：[GitHub Issues](https://github.com/b8l8u8e8/siyuan-plugin-share/issues)
- **开源协议**：[MIT License](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/LICENSE)
- **更新日志**: [CHANGELOG.md](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/CHANGELOG.md)


