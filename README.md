# 🔗 Siyuan Share

**Siyuan Share** is a **free and open-source** plugin for **Siyuan Note** that allows you to generate **publicly accessible share links** for **entire notebooks or individual documents**.  
It supports **access passwords, expiration time, visitor limits**, and provides **access statistics**, making it ideal for knowledge sharing, collaboration, and temporary public publishing.

🌍 Documentation Languages:  
[中文 README](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README_zh_CN.md) ｜ [English README](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README.md)

---

## ✨ How to Use

### 📌 Entry Point

In the **document tree**, right-click on a **notebook or document** → open the **plugin menu**, where you can:

- 🆕 Create Share / Manage Share  
- 🔄 Update Share  
- 📋 Copy Share Link  
- 🗑️ Delete Share  

### 🗂️ Share Management

Open the **plugin settings page** to view and manage **all created shares** in one place.

---

## 🔐 Access Settings

- **Access Password**  
  Set a password for the share. Visitors must enter the correct password to view the content.

- **Expiration Time**  
  After the expiration time, the share will be marked as **expired** and become inaccessible.

  > ⚠️ Cloud data is **not automatically deleted**. You can manually clean it up to save storage space.

- **Visitor Limit**  
  Set the maximum number of visitors.

  - New visitors will be blocked once the limit is reached  
  - Existing visitors can continue to access  
  - Multiple visits from the same browser count as **one visitor**

---

## ⚠️ Notes & Best Practices

- **Content Update Mechanism**
  - If you **modify the document or notebook content**, use **“Update Share”**  
    → Keeps the same share link while syncing the latest content
  - If you only **change access settings** (password / expiration, etc.), use **“Update Access Settings”**  
    → No need to re-upload content, saving time and bandwidth

- **Link Change Rules**
  If you **delete a share and then create a new one**,  
  👉 A **new share link** will be generated and the old link will become invalid immediately.

---

## ⚙️ Plugin Configuration

This plugin relies on a server-side service:  
🌐 **[share.b0x.top](https://share.b0x.top)** (used for data storage and access)

### 1️⃣ Configuration Steps

1. Register an account on the server website  
2. Generate an **API Key** on the website  
3. Enter the API Key in the plugin settings  
4. After configuration, you can start sharing  

   > Sharing essentially uploads the selected document or notebook to the server

### 2️⃣ Server Notes

- **Public Service Disclaimer**  
  The current `share.b0x.top` is a **public server provided by the author**,  
  mainly for **feature testing and short-term use**.

- **Data Cleanup Policy**  
  Due to bandwidth and storage limitations,  
  **large documents or notebooks may be cleaned up** periodically.

- **Private Deployment (Strongly Recommended)**  
  If you need **long-term sharing**,  
  please refer to 👉 **[Server Deployment Guide](https://ccnwc9xa9692.feishu.cn/wiki/MQCtwMtQaifPuak4zl3cIMCqnLx)**  
  to deploy your own private server.

---

## 📖 Feature Demo

### ① Generate an API Key and configure the plugin

![Generate API Key](https://github.com/user-attachments/assets/40bb0a47-d3f5-48fc-a96b-acd46fc6287d)

---

### ② Share a document or notebook

![Share document](https://github.com/user-attachments/assets/82a5be6a-9a3e-4153-92a5-85e180c12d0e)

---

### ③ Open the share link to view content

![Open shared document](https://github.com/user-attachments/assets/ba14f2b1-2bd0-4dfb-a32a-04ad1e7b5567)

---

### ④ Access statistics overview

![Access statistics](https://github.com/user-attachments/assets/b2690a03-6e97-4845-87be-1ab3e5406847)

---

## ☕ Support the Author

If you find this project helpful, feel free to support the author ❤️  
Your support motivates me to **continue maintaining and improving** the plugin.

<div align="center">
    <a href="https://github.com/b8l8u8e8/siyuan-plugin-share">
        <img src="https://img.shields.io/github/stars/b8l8u8e8/siyuan-plugin-share?style=for-the-badge&color=ffd700&label=⭐%20Star%20Support" alt="Github Star">
    </a>
</div>

<div align="center" style="margin-top: 40px;">
    <div style="display: flex; justify-content: center; align-items: center; gap: 30px;">
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/81d0a064-b760-4e97-9c9b-bf83f6cafc8a" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #07c160;">
            <br/>
            <b style="color: #07c160; margin-top: 10px; display: block;">WeChat Pay</b>
        </div>
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/9e1988d0-4016-4b8d-9ea6-ce8ff714ee17" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #1677ff;">
            <br/>
            <b style="color: #1677ff; margin-top: 10px; display: block;">Alipay</b>
        </div>
    </div>
    <p style="margin-top: 20px;"><i>Your support is my greatest motivation to keep improving 🙏</i></p>
</div>

---

## 🛠️ Additional Information

- 🐞 Issue Tracking:  
  [GitHub Issues](https://github.com/b8l8u8e8/siyuan-plugin-share/issues)

- 📄 License:  
  [MIT License](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/LICENSE)

- 🧾 Changelog:  
  [CHANGELOG.md](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/CHANGELOG.md)
