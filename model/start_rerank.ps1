# 一键启动本地 Rerank 服务（Qwen3-Reranker-0.6B via llama.cpp + 分数反相代理）
# 用法：powershell -ExecutionPolicy Bypass -File start_rerank.ps1
# 启动后：llama-server 在 8000（原生），代理在 8001（LightRAG 用这个）

$ErrorActionPreference = 'Stop'

$llamaExe   = 'D:\llama.cpp\llama-server.exe'
$modelFile  = 'D:\A-lvrong\PythonProject\KnowledgeBase\model\Qwen3-Reranker-0.6B-Q8_0-GGUF\qwen3-reranker-0.6b-q8_0.gguf'
$proxyPy    = 'D:\A-lvrong\PythonProject\KnowledgeBase\model\rerank_proxy.py'
$pythonExe  = 'D:\A-lvrong\PythonProject\KnowledgeBase\.venv\Scripts\python.exe'

# 1) 启动 llama-server（rerank 模式，端口 8000）
Write-Host "[1/2] 启动 llama-server (rerank 模式, :8000) ..."
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process -FilePath $llamaExe -ArgumentList @('-m', $modelFile, '--port', '8000', '--rerank', '--host', '127.0.0.1', '-c', '32768', '-ub', '4096', '-t', '14', '-tb', '14', '-fa', 'on') -WindowStyle Hidden

# 等待模型加载
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200 -and $r.Content -match 'ok') { $ready = $true; break }
    } catch {}
}
if (-not $ready) { Write-Host "ERROR: llama-server 未就绪"; exit 1 }
Write-Host "llama-server 就绪"

# 2) 启动分数反相代理（端口 8001）
Write-Host "[2/2] 启动 rerank 代理 (:8001) ..."
Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $pythonExe -and $_.CommandLine -match 'rerank_proxy' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $pythonExe -ArgumentList @($proxyPy) -WindowStyle Hidden
Start-Sleep -Seconds 2

# 验证代理
$body = '{"model":"Qwen3-Reranker-0.6B","query":"北京是中国的首都","documents":["北京是中华人民共和国的首都","苹果是一种水果"]}'
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/rerank' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 60
    Write-Host "代理验证 OK:"
    $resp.results | Sort-Object { $_.index } | ForEach-Object { Write-Host ("  文档[{0}] score={1}" -f $_.index, $_.relevance_score) }
} catch {
    Write-Host "代理验证失败: $($_.Exception.Message)"
    exit 1
}
Write-Host "`n完成。LightRAG 配置指向: http://127.0.0.1:8001/rerank"
