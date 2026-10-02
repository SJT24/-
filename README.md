# 善鸡通AI 公网版

零依赖 Node 服务。注册登录、关注时间线、兴趣推荐、图片/视频、列表、社群、SSE 实时推送。数据写在 `data/db.json`，媒体在 `uploads/`。

## 本地

```bash
node server.js
```

打开 http://localhost:8080 。端口用环境变量 `PORT`。

## 上传公网

不能丢到纯静态托管（GitHub Pages / 对象存储网页），账号和上传需要这个进程一直跑。

- **Render**：New Web Service，连仓库或上传本目录，Start Command `node server.js`。磁盘要挂到 `data` 和 `uploads`，否则重启丢数据。
- **Railway / Fly.io**：同样用 `node server.js`，或直接用附带的 `Dockerfile`。
- **自己的 VPS**：`node server.js`，前面加 Caddy / Nginx 反代并上 HTTPS。

首次打开页面即可注册。推荐流按关注、社群、话题重合、互动和新鲜度打分，不是外部大模型。
