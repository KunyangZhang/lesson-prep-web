import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const host = process.env.UPLOAD_HOST || "0.0.0.0";
const port = Number(process.env.UPLOAD_PORT || 3002);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "/root/uploads");
const maxFileMb = Number(process.env.UPLOAD_MAX_FILE_MB || 2048);

fs.mkdirSync(uploadDir, { recursive: true });

function safeName(value) {
  const base = path.basename(Buffer.from(value || "file", "latin1").toString("utf8"));
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "file";
}

function uniquePath(originalName) {
  const parsed = path.parse(safeName(originalName));
  let candidate = path.join(uploadDir, `${parsed.name}${parsed.ext}`);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(uploadDir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => callback(null, path.basename(uniquePath(file.originalname)))
});
const upload = multer({
  storage,
  limits: { fileSize: maxFileMb * 1024 * 1024, files: 100 }
});

const app = express();
app.disable("x-powered-by");
app.use("/results", express.static(uploadDir, { index: "index.html", dotfiles: "deny" }));

app.get("/", (_req, res) => {
  const visibleDir = uploadDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  res.type("html").send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>文件上传</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17202a;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}.page{width:min(680px,calc(100% - 32px));margin:64px auto}.panel{background:#fff;border:1px solid #dce1e6;border-radius:8px;padding:28px;box-shadow:0 8px 24px rgba(20,30,40,.08)}h1{font-size:24px;margin:0 0 8px}p{margin:0 0 22px;color:#52606d}.drop{display:grid;place-items:center;min-height:190px;padding:24px;border:2px dashed #aab4be;border-radius:8px;background:#fafbfc;text-align:center;cursor:pointer}.drop.over{border-color:#1473e6;background:#eef6ff}.drop strong{display:block;margin-bottom:6px}.drop small{color:#687784}input{display:none}button{margin-top:18px;width:100%;height:44px;border:0;border-radius:6px;background:#1473e6;color:#fff;font:600 15px system-ui;cursor:pointer}button:disabled{background:#95a5b3;cursor:not-allowed}.files{margin:18px 0 0;padding:0;list-style:none}.files li{padding:8px 0;border-bottom:1px solid #edf0f2;overflow-wrap:anywhere}.status{min-height:24px;margin-top:16px;color:#1c6b3c}.status.error{color:#b42318}
    .results{display:inline-block;margin:0 0 22px;color:#0d5f52;font-weight:650;text-decoration:none}.results:hover{text-decoration:underline}
  </style>
</head>
<body><main class="page"><section class="panel"><h1>上传文件</h1><p>文件会保存到服务器的 ${visibleDir}</p><a class="results" href="/results/finance-topic-test-2026-07-29/">查看财经选题测试结果</a><label class="drop" id="drop"><input id="files" type="file" multiple><span><strong>选择文件或拖到这里</strong><small>单个文件最大 ${maxFileMb} MB，一次最多 100 个</small></span></label><ul class="files" id="list"></ul><button id="upload" disabled>上传</button><div class="status" id="status" role="status"></div></section></main>
<script>
const input=document.querySelector('#files'),drop=document.querySelector('#drop'),list=document.querySelector('#list'),button=document.querySelector('#upload'),status=document.querySelector('#status');
let selected=[];
function show(files){selected=[...files];list.innerHTML=selected.map(f=>'<li>'+escapeHtml(f.name)+' · '+formatSize(f.size)+'</li>').join('');button.disabled=!selected.length;status.textContent='';status.className='status'}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function formatSize(n){if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
input.addEventListener('change',()=>show(input.files));
for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('over')});
for(const event of ['dragleave','drop'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('over')});
drop.addEventListener('drop',e=>show(e.dataTransfer.files));
button.addEventListener('click',async()=>{button.disabled=true;status.textContent='正在上传…';const data=new FormData();selected.forEach(file=>data.append('files',file));try{const response=await fetch('/upload',{method:'POST',body:data});const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');status.textContent='上传成功：'+result.files.map(f=>f.name).join('、');selected=[];list.innerHTML='';input.value=''}catch(error){status.textContent=error.message;status.className='status error'}finally{button.disabled=!selected.length}});
</script></body></html>`);
});

app.post("/upload", upload.array("files"), (req, res) => {
  const files = (req.files || []).map((file) => ({
    name: file.filename,
    size: file.size
  }));
  if (files.length === 0) return res.status(400).json({ error: "没有收到文件，表单字段名应为 files" });
  return res.json({ ok: true, directory: uploadDir, files });
});

app.use((error, _req, res, _next) => {
  const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
    ? `文件超过 ${maxFileMb} MB 限制`
    : error?.message || "上传失败";
  res.status(400).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`Upload server listening on http://${host}:${port}`);
  console.log(`Files will be saved to ${uploadDir}`);
});
