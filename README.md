# Siyuan Share

This is a free sharing plugin for SiYuan Note. It supports generating share links for notebooks or documents, allowing you to set access passwords and expiration dates.

[中文](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README_zh_CN.md) | [English](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README.md)

## ✨ Usage

- **Access**: Right-click on a notebook or document in the file tree to enter the plugin menu. The menu includes the following functions:
    - Create Share
    - Update Share
    - Copy Share Link
    - Delete Share
- **Share Management**: Go to the plugin settings page to view and manage the list of all generated shares.

## ⚠️ Important Notes

- **Update Mechanism**: If you modify the content of a document or notebook, please use the **"Update Share"** function. This keeps the original share link unchanged while syncing the latest content.
- **Link Change**: If you select "Delete Share" and then "Create Share" again, the system will generate a new share link, and the old link will become invalid.

## ⚙️ Configuration

This plugin relies on the server-side website [share.b0x.top](https://share.b0x.top) for data transmission.

1.  **Configuration Steps**:
    - Please go to the website to register an account.
    - Generate an **API Key** on the website.
    - Enter the API Key into the plugin settings to complete the connection between the plugin and the server.
    - Once configured, the sharing operation uploads the corresponding document/notebook to the server.

2.  **Server Information**:
    - Currently, [share.b0x.top](https://share.b0x.top) is a **public** server provided by the author for demonstration and short-term use.
    - **Cleanup Policy**: Due to limited server bandwidth and storage costs, the system performs periodic cleanup on large files.
    - **Self-hosting Suggestion**: For users with long-term persistent storage needs, it is strongly recommended to refer to the [Server Deployment Tutorial](https://ccnwc9xa9692.feishu.cn/wiki/MQCtwMtQaifPuak4zl3cIMCqnLx) for self-hosting.

## 📖 Demo

### 1. Generate API Key and fill it in

![Generate API Key and fill it in](https://github.com/user-attachments/assets/40bb0a47-d3f5-48fc-a96b-acd46fc6287d)

### 2. Share Document

![Share Document](https://github.com/user-attachments/assets/82a5be6a-9a3e-4153-92a5-85e180c12d0e)

### 3. Open Shared Document

![Open Shared Document](https://github.com/user-attachments/assets/ba14f2b1-2bd0-4dfb-a32a-04ad1e7b5567)

## ☕ Support the Author

If you find this project helpful, your support is welcome! It encourages me to keep updating and building better tools.

<div align="center">
    <a href="https://github.com/b8l8u8e8/siyuan-plugin-share">
        <img src="https://img.shields.io/github/stars/b8l8u8e8/siyuan-plugin-share?style=for-the-badge&color=ffd700&label=Give%20a%20Star" alt="Github Star">
    </a>
</div>
<div align="center" style="margin-top: 40px;">
    <div style="display: flex; justify-content: center; align-items: center; gap: 30px;">
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/81d0a064-b760-4e97-9c9b-bf83f6cafc8a" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #07c160; object-fit: contain; display: inline-block;">
            <br/>
            <b style="color: #07c160; display: block; margin-top: 10px;">WeChat Pay</b>
        </div>
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/9e1988d0-4016-4b8d-9ea6-ce8ff714ee17" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #1677ff; object-fit: contain; display: inline-block;">
            <br/>
            <b style="color: #1677ff; display: block; margin-top: 10px;">Alipay</b>
        </div>
    </div>
    <p style="margin-top: 20px;"><i>Your support is my motivation for continuous iteration</i></p>
</div>

### 🛠️ Other Information

- **Feedback**: [GitHub Issues](https://github.com/b8l8u8e8/siyuan-plugin-share/issues)
- **License**: [MIT License](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/LICENSE)
- **Changelog**: [CHANGELOG.md](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/CHANGELOG.md)

