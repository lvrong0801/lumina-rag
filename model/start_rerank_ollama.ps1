# Start the Ollama rerank proxy (LightRAG cohere -> Ollama /v1/rerank)
# Requires: python (or py -3) with stdlib only; Ollama already running with hans-tech/bge-reranker-v2-m3:260522

$proxy = Join-Path $PSScriptRoot 'rerank_proxy_ollama.py'
$log = 'D:\rerank_proxy_ollama.log'

if (Test-Path $log) {
    Remove-Item $log -Force
    Write-Host "Cleared old log: $log"
}

Write-Host "Starting rerank proxy on 127.0.0.1:8001 -> http://127.0.0.1:11434/v1/rerank"
Write-Host "Log: $log"
Write-Host "Press Ctrl+C to stop"
Write-Host ""

python $proxy
