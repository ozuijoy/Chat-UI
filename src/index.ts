/**
 * Cloudflare Worker - Chat UI Backend
 * 提供AI聊天、圖片生成、文本嵌入等API服務
 */

// ============================================
// 類型定義
// ============================================

export interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AUTH_PASSWORD: string;
  SESSION_SECRET: string;
  // KV 綁定建議在 Cloudflare Dashboard 中配置，變數名稱為 CHAT_MEMORY
  CHAT_MEMORY?: KVNamespace;
}

interface LoginRequest {
  password: string;
}

interface ChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}

interface GenerateImageRequest {
  prompt: string;
  steps?: number;
  width?: number;
  height?: number;
}

interface EmbeddingsRequest {
  text: string;
}

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

// 支持的模型配置
const SUPPORTED_MODELS = {
  chat: [
    { id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', name: 'Llama 3.1 8B Instruct FP8', description: '默認對話模型，快速高效' },
    { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B Instruct', description: '備選對話模型，更強推理能力' },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B Instruct', description: '程式碼模式專用模型' },
  ],
  image: [
    { id: '@cf/black-forest-labs/flux-2-dev', name: 'FLUX.2 Dev', description: '高質量圖像生成' },
  ],
  embedding: [
    { id: '@cf/pfnet/plamo-embedding-1b', name: 'Plamo Embedding 1B', description: '文字嵌入模型' },
  ],
};

// ============================================
// CORS 配置
// ============================================

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function createCORSResponse(body: BodyInit | null, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function createJSONResponse(data: unknown, status: number = 200): Response {
  return createCORSResponse(
    JSON.stringify(data),
    status,
    { 'Content-Type': 'application/json' }
  );
}

function createErrorResponse(message: string, status: number = 400): Response {
  return createJSONResponse({ error: message }, status);
}

// ============================================
// JWT 工具函數 (使用 Web Crypto API)
// ============================================

async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  
  // 使用 SHA-256 哈希密鑰
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyData);
  
  return crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(str: string): ArrayBuffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const decoded = atob(base64 + padding);
  return Uint8Array.from([...decoded].map(c => c.charCodeAt(0))).buffer;
}

async function signJWT(payload: Omit<JwtPayload, 'iat'>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const iat = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat };
  
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importKey(secret);
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signingInput)
  );
  
  const signatureB64 = base64UrlEncode(signature);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;
    
    const key = await importKey(secret);
    const signature = base64UrlDecode(signatureB64);
    
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(signingInput)
    );
    
    if (!valid) return null;
    
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload: JwtPayload = JSON.parse(payloadJson);
    
    // 檢查過期時間
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    
    return payload;
  } catch {
    return null;
  }
}

// ============================================
// 認證中間件
// ============================================

async function authenticateRequest(request: Request, env: Env): Promise<JwtPayload | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.substring(7);
  return verifyJWT(token, env.SESSION_SECRET);
}

// ============================================
// Cloudflare AI API 調用
// ============================================

async function callCloudflareAI(
  accountId: string,
  apiToken: string,
  model: string,
  input: unknown
): Promise<Response> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

// ============================================
// 前端 HTML 頁面
// ============================================

function getFrontendHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CF ChatUI</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Space Grotesk', 'sans-serif'],
                        mono: ['JetBrains Mono', 'monospace'],
                    },
                    colors: {
                        dark: {
                            900: '#0a0a0f',
                            800: '#12121a',
                            700: '#1a1a25',
                            600: '#252532',
                            500: '#333344',
                            400: '#555566',
                        },
                        accent: {
                            blue: '#6366f1',
                            cyan: '#06b6d4',
                            purple: '#8b5cf6',
                            green: '#10b981',
                            pink: '#ec4899',
                        }
                    }
                }
            }
        }
    </script>
    <style>
        * {
            box-sizing: border-box;
        }
        
        html, body {
            margin: 0;
            padding: 0;
            height: 100%;
        }
        
        body {
            font-family: 'Space Grotesk', sans-serif;
            background: #0a0a0f;
            color: #e5e7eb;
            overflow: hidden;
        }
        
        /* 動態漸變背景 */
        .gradient-bg {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: 
                radial-gradient(ellipse at 20% 30%, rgba(99, 102, 241, 0.08) 0%, transparent 50%),
                radial-gradient(ellipse at 80% 70%, rgba(6, 182, 212, 0.06) 0%, transparent 50%),
                radial-gradient(ellipse at 50% 50%, rgba(139, 92, 246, 0.04) 0%, transparent 60%),
                linear-gradient(135deg, #0a0a0f 0%, #12121a 50%, #0a0a0f 100%);
            z-index: -2;
        }
        
        /* 噪點紋理 */
        .noise-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            opacity: 0.03;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
            z-index: -1;
            pointer-events: none;
        }
        
        /* 滾動條樣式 */
        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        
        ::-webkit-scrollbar-thumb {
            background: rgba(99, 102, 241, 0.3);
            border-radius: 3px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(99, 102, 241, 0.5);
        }
        
        /* 登入動畫 */
        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        @keyframes pulse-glow {
            0%, 100% { box-shadow: 0 0 20px rgba(99, 102, 241, 0.3); }
            50% { box-shadow: 0 0 40px rgba(99, 102, 241, 0.5); }
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
        }
        
        @keyframes gradient-flow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        
        .login-container {
            animation: slideUp 0.8s ease-out;
        }
        
        .floating {
            animation: float 3s ease-in-out infinite;
        }
        
        .gradient-text {
            background: linear-gradient(135deg, #6366f1 0%, #06b6d4 50%, #8b5cf6 100%);
            background-size: 200% 200%;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            animation: gradient-flow 3s ease infinite;
        }
        
        /* 輸入框樣式 */
        .input-field {
            background: rgba(26, 26, 37, 0.8);
            border: 1px solid rgba(99, 102, 241, 0.2);
            transition: all 0.3s ease;
        }
        
        .input-field:focus {
            outline: none;
            border-color: rgba(99, 102, 241, 0.5);
            box-shadow: 0 0 20px rgba(99, 102, 241, 0.15);
        }
        
        /* 按鈕樣式 */
        .btn-primary {
            background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(99, 102, 241, 0.4);
        }
        
        .btn-primary::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s ease;
        }
        
        .btn-primary:hover::before {
            left: 100%;
        }
        
        /* 模型卡片 */
        .model-card {
            background: linear-gradient(135deg, rgba(26, 26, 37, 0.9) 0%, rgba(18, 18, 26, 0.9) 100%);
            border: 1px solid rgba(99, 102, 241, 0.15);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        
        .model-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.5), transparent);
        }
        
        .model-card:hover {
            border-color: rgba(99, 102, 241, 0.4);
            transform: translateY(-3px);
            box-shadow: 0 10px 30px rgba(99, 102, 241, 0.2);
        }
        
        .model-card.active {
            border-color: rgba(99, 102, 241, 0.8);
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(26, 26, 37, 0.95) 100%);
            box-shadow: 0 0 30px rgba(99, 102, 241, 0.25), inset 0 1px 0 rgba(99, 102, 241, 0.3);
        }
        
        /* 消息氣泡 */
        .message {
            animation: slideUp 0.4s ease-out;
        }
        
        .message-user {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(79, 70, 229, 0.15) 100%);
            border: 1px solid rgba(99, 102, 241, 0.2);
        }
        
        .message-ai {
            background: rgba(37, 37, 50, 0.8);
            border: 1px solid rgba(99, 102, 241, 0.1);
        }
        
        /* 打字動畫 */
        .typing-dot {
            width: 8px;
            height: 8px;
            background: linear-gradient(135deg, #6366f1 0%, #06b6d4 100%);
            border-radius: 50%;
            animation: typing 1.4s infinite ease-in-out;
        }
        
        .typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .typing-dot:nth-child(3) { animation-delay: 0.4s; }
        
        @keyframes typing {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-8px); opacity: 1; }
        }
        
        /* 代碼塊樣式 */
        pre {
            background: rgba(10, 10, 15, 0.8) !important;
            border: 1px solid rgba(99, 102, 241, 0.15);
            border-radius: 8px;
        }
        
        code {
            font-family: 'JetBrains Mono', monospace;
        }
        
        /* 加載動畫 */
        .loading-ring {
            width: 40px;
            height: 40px;
            border: 3px solid rgba(99, 102, 241, 0.1);
            border-top: 3px solid #6366f1;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        /* 側邊欄 */
        .sidebar {
            background: linear-gradient(180deg, rgba(18, 18, 26, 0.98) 0%, rgba(10, 10, 15, 0.98) 100%);
            border-right: 1px solid rgba(99, 102, 241, 0.1);
        }
        
        /* 導航欄 */
        .navbar {
            background: rgba(18, 18, 26, 0.8);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid rgba(99, 102, 241, 0.1);
        }
        
        /* 輸入區域 */
        .input-area {
            background: rgba(18, 18, 26, 0.9);
            backdrop-filter: blur(10px);
            border-top: 1px solid rgba(99, 102, 241, 0.1);
        }
        
        /* 圖片生成區域 */
        .image-preview {
            background: linear-gradient(135deg, rgba(26, 26, 37, 0.8) 0%, rgba(18, 18, 26, 0.8) 100%);
            border: 2px dashed rgba(99, 102, 241, 0.3);
        }
        
        .image-preview.has-image {
            border-style: solid;
            border-color: rgba(99, 102, 241, 0.5);
        }
        
        /* 嵌入結果 */
        .embedding-result {
            background: rgba(10, 10, 15, 0.6);
            font-family: 'JetBrains Mono', monospace;
        }
        
        /* 滑塊樣式 */
        input[type="range"] {
            -webkit-appearance: none;
            height: 6px;
            background: rgba(99, 102, 241, 0.2);
            border-radius: 3px;
            outline: none;
        }
        
        input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            background: linear-gradient(135deg, #6366f1 0%, #06b6d4 100%);
            border-radius: 50%;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        input[type="range"]::-webkit-slider-thumb:hover {
            transform: scale(1.2);
            box-shadow: 0 0 15px rgba(99, 102, 241, 0.5);
        }
    </style>
</head>
<body>
    <div class="gradient-bg"></div>
    <div class="noise-overlay"></div>
    
    <!-- 登入頁面 -->
    <div id="loginPage" class="fixed inset-0 flex items-center justify-center z-50">
        <div class="login-container relative w-full max-w-md p-8 mx-4">
            <!-- 裝飾性光暈 -->
            <div class="absolute -top-20 -left-20 w-40 h-40 bg-accent-blue/20 rounded-full blur-3xl"></div>
            <div class="absolute -bottom-20 -right-20 w-40 h-40 bg-accent-cyan/20 rounded-full blur-3xl"></div>
            
            <div class="relative bg-dark-800/80 backdrop-blur-xl rounded-2xl p-8 border border-accent-blue/20 shadow-2xl">
                <div class="text-center mb-8">
                    <div class="floating inline-flex items-center justify-center w-16 h-16 mb-4 rounded-2xl bg-gradient-to-br from-accent-blue to-accent-cyan shadow-lg">
                        <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                        </svg>
                    </div>
                    <h1 class="text-3xl font-bold gradient-text mb-2">CF ChatUI</h1>
                    <p class="text-dark-400 text-sm">Cloudflare Workers AI 智能對話平臺</p>
                </div>
                
                <form id="loginForm" class="space-y-6">
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-2">訪問密碼</label>
                        <div class="relative">
                            <input 
                                type="password" 
                                id="passwordInput" 
                                placeholder="請輸入密碼"
                                class="input-field w-full px-4 py-3 rounded-xl text-white placeholder-gray-500"
                                required
                            >
                            <div class="absolute right-3 top-1/2 -translate-y-1/2">
                                <svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                                </svg>
                            </div>
                        </div>
                    </div>
                    
                    <div id="loginError" class="hidden text-red-400 text-sm text-center bg-red-500/10 py-2 rounded-lg border border-red-500/20">
                    </div>
                    
                    <button type="submit" class="btn-primary w-full py-3 rounded-xl font-semibold text-white flex items-center justify-center gap-2">
                        <span id="loginText">登入</span>
                        <div id="loginLoading" class="hidden loading-ring w-5 h-5 border-2"></div>
                    </button>
                </form>
                
                <div class="mt-6 text-center text-xs text-gray-500">
                    <p>受保護的服務 · 需要有效密碼</p>
                </div>
            </div>
        </div>
    </div>
    
    <!-- 主界面 -->
    <div id="mainPage" class="hidden h-screen flex flex-col">
        <!-- 導航欄 -->
        <nav class="navbar h-16 flex items-center justify-between px-6 flex-shrink-0">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-accent-cyan flex items-center justify-center shadow-lg">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                    </svg>
                </div>
                <h1 class="text-xl font-bold gradient-text">CF ChatUI</h1>
                <span id="currentModelBadge" class="hidden ml-4 px-3 py-1 rounded-full text-xs font-medium bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                </span>
            </div>
            <button id="logoutBtn" class="group flex items-center gap-2 px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-all">
                <span class="text-sm">登出</span>
                <svg class="w-5 h-5 group-hover:rotate-180 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                </svg>
            </button>
        </nav>
        
        <!-- 主體區域 -->
        <div class="flex flex-1 overflow-hidden" style="height: calc(100vh - 73px);">
            <!-- 左側邊欄 - 模型選擇 -->
            <aside class="sidebar w-80 flex-shrink-0 flex flex-col overflow-y-auto">
                <div class="p-4">
                    <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">選擇模型</h2>
                    
                    <div class="space-y-3">
                        <!-- Llama 3.1 8B Instruct (預設) -->
                        <div class="model-card p-4 rounded-xl cursor-pointer" data-model="@cf/meta/llama-3.1-8b-instruct-fp8-fast" data-type="chat">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-blue to-accent-purple flex items-center justify-center flex-shrink-0">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2 mb-1">
                                        <span class="font-semibold text-sm text-white truncate">Llama-3.1-8B</span>
                                        <span class="px-2 py-0.5 text-xs rounded-full bg-accent-blue/20 text-accent-blue border border-accent-blue/30">對話</span>
                                    </div>
                                    <p class="text-xs text-gray-500 leading-relaxed">Meta Llama 3.1 快速對話模型，FP8 加速，適合日常對話</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- GPT-OSS-120b -->
                        <div class="model-card p-4 rounded-xl cursor-pointer" data-model="@cf/meta/llama-4-scout-17b-16e-instruct" data-type="chat">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-green to-accent-cyan flex items-center justify-center flex-shrink-0">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2 mb-1">
                                        <span class="font-semibold text-sm text-white truncate">Llama-4-Scout-17B-Instruct</span>
                                        <span class="px-2 py-0.5 text-xs rounded-full bg-accent-green/20 text-accent-green border border-accent-green/30">對話</span>
                                    </div>
                                    <p class="text-xs text-gray-500 leading-relaxed">Meta Llama 4 Scout，170 億參數，推理能力強</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Mistral Small 3.1 24B Instruct - 程式碼模式 -->
                        <div class="model-card p-4 rounded-xl cursor-pointer" data-model="@cf/mistralai/mistral-small-3.1-24b-instruct" data-type="chat">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-pink to-accent-purple flex items-center justify-center flex-shrink-0">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2 mb-1">
                                        <span class="font-semibold text-sm text-white truncate">Mistral-Small-3.1-24B-Instruct</span>
                                        <span class="px-2 py-0.5 text-xs rounded-full bg-accent-pink/20 text-accent-pink border border-accent-pink/30">程式碼</span>
                                    </div>
                                    <p class="text-xs text-gray-500 leading-relaxed">Mistral Small 3.1，240 億參數，程式碼模式專用</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- FLUX-2-Dev -->
                        <div class="model-card p-4 rounded-xl cursor-pointer" data-model="@cf/black-forest-labs/flux-2-dev" data-type="image">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-green to-accent-cyan flex items-center justify-center flex-shrink-0">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2 mb-1">
                                        <span class="font-semibold text-sm text-white truncate">FLUX-2-Dev</span>
                                        <span class="px-2 py-0.5 text-xs rounded-full bg-accent-green/20 text-accent-green border border-accent-green/30">圖片</span>
                                    </div>
                                    <p class="text-xs text-gray-500 leading-relaxed">FLUX 高質量圖片生成模型</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Plamo-Embedding -->
                        <div class="model-card p-4 rounded-xl cursor-pointer" data-model="@cf/pfnet/plamo-embedding-1b" data-type="embedding">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-accent-cyan to-accent-blue flex items-center justify-center flex-shrink-0">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/>
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2 mb-1">
                                        <span class="font-semibold text-sm text-white truncate">Plamo-Embedding</span>
                                        <span class="px-2 py-0.5 text-xs rounded-full bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30">嵌入</span>
                                    </div>
                                    <p class="text-xs text-gray-500 leading-relaxed">文字嵌入模型，將文字轉換為向量表示</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 底部信息 -->
                <div class="mt-auto p-4 border-t border-accent-blue/10">
                    <div class="text-xs text-gray-600 text-center">
                        <p>Powered by Cloudflare Workers AI</p>
                    </div>
                </div>
            </aside>
            
            <!-- 右側主內容區 -->
            <main class="flex-1 flex flex-col relative min-h-0" style="overflow: visible;">
                <!-- 歡迎頁面 -->
                <div id="welcomeScreen" class="flex-1 flex items-center justify-center">
                    <div class="text-center p-8">
                        <div class="floating inline-flex items-center justify-center w-24 h-24 mb-6 rounded-2xl bg-gradient-to-br from-accent-blue via-accent-cyan to-accent-purple shadow-2xl">
                            <svg class="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/>
                            </svg>
                        </div>
                        <h2 class="text-2xl font-bold text-white mb-2">選擇一個模型開始</h2>
                        <p class="text-gray-500 max-w-md mx-auto">從左側選擇對話模型、圖片生成模型或文字嵌入模型，開始您的 AI 之旅</p>
                    </div>
                </div>
                
                <!-- 對話模式 -->
                <div id="chatMode" class="hidden flex-1 flex flex-col min-h-0">
                    <!-- 聊天記錄 -->
                    <div id="chatMessages" class="flex-1 overflow-y-auto p-6 space-y-6 min-h-0">
                        <!-- 訊息會動態新增到這裡 -->
                    </div>
                    
                    <!-- 輸入區域 -->
                    <div class="input-area p-4 flex-shrink-0">
                        <div class="max-w-4xl mx-auto">
                            <div class="relative flex items-end gap-3 bg-dark-700/50 rounded-2xl border border-accent-blue/20 p-3 focus-within:border-accent-blue/50 transition-colors">
                                <textarea 
                                    id="chatInput" 
                                    rows="1"
                                    placeholder="輸入訊息，按 Enter 傳送，Shift+Enter 換行..."
                                    class="flex-1 bg-transparent text-white placeholder-gray-500 resize-none outline-none max-h-32 py-2 px-1"
                                ></textarea>
                                <button id="sendBtn" class="btn-primary w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                                    </svg>
                                </button>
                            </div>
                            <p class="text-xs text-gray-600 mt-2 text-center">CF ChatUI 可能產生不準確的資訊，請驗證重要資訊。</p>
<div class="mt-3 flex items-center gap-3 text-xs text-gray-500">
                                <label class="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" id="memoryToggle" checked class="w-4 h-4 rounded accent-indigo-500">
                                    <span>記憶模式（聊天記錄保存至 KV）</span>
                                </label>
                                <button id="clearHistoryBtn" class="px-3 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-colors">
                                    清除記錄
                                </button>
                                <button id="loadHistoryBtn" class="px-3 py-1 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 transition-colors">
                                    載入歷史
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 圖片生成模式 -->
                <div id="imageMode" class="hidden flex-1 flex flex-col overflow-y-auto">
                    <div class="flex-1 p-6">
                        <div class="max-w-3xl mx-auto space-y-6">
                            <!-- 提示詞輸入 -->
                            <div class="bg-dark-700/50 rounded-2xl border border-accent-blue/20 p-6">
                                <label class="block text-sm font-medium text-gray-400 mb-3">提示詞</label>
                                <textarea 
                                    id="imagePrompt" 
                                    rows="4"
                                    placeholder="描述您想要產生的圖片..."
                                    class="input-field w-full px-4 py-3 rounded-xl text-white placeholder-gray-500 resize-none"
                                ></textarea>
                            </div>
                            
                            <!-- 參數設定 -->
                            <div class="bg-dark-700/50 rounded-2xl border border-accent-blue/20 p-6">
                                <h3 class="text-sm font-medium text-gray-400 mb-4">參數設定</h3>
                                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                                    <div>
                                        <label class="block text-xs text-gray-500 mb-2">迭代步數 (Steps): <span id="stepsValue" class="text-accent-cyan">25</span></label>
                                        <input type="range" id="stepsInput" min="1" max="50" value="25" class="w-full">
                                    </div>
                                    <div>
                                        <label class="block text-xs text-gray-500 mb-2">寬度: <span id="widthValue" class="text-accent-cyan">1024</span>px</label>
                                        <select id="widthInput" class="input-field w-full px-3 py-2 rounded-lg text-sm text-white">
                                            <option value="512">512px</option>
                                            <option value="768">768px</option>
                                            <option value="1024" selected>1024px</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label class="block text-xs text-gray-500 mb-2">高度: <span id="heightValue" class="text-accent-cyan">1024</span>px</label>
                                        <select id="heightInput" class="input-field w-full px-3 py-2 rounded-lg text-sm text-white">
                                            <option value="512">512px</option>
                                            <option value="768">768px</option>
                                            <option value="1024" selected>1024px</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- 生成按鈕 -->
                            <button id="generateImageBtn" class="btn-primary w-full py-4 rounded-xl font-semibold text-white flex items-center justify-center gap-2">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                </svg>
                                <span id="generateImageText">產生圖片</span>
                                <div id="generateImageLoading" class="hidden loading-ring w-5 h-5 border-2"></div>
                            </button>
                            
                            <!-- 圖片預覽 -->
                            <div id="imagePreview" class="image-preview rounded-2xl p-8 min-h-80 flex items-center justify-center">
                                <div class="text-center">
                                    <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-dark-600 flex items-center justify-center">
                                        <svg class="w-10 h-10 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                        </svg>
                                    </div>
                                    <p class="text-gray-500">產生的圖片將在此顯示</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 嵌入模式 -->
                <div id="embeddingMode" class="hidden flex-1 flex flex-col overflow-y-auto">
                    <div class="flex-1 p-6">
                        <div class="max-w-3xl mx-auto space-y-6">
                            <!-- 文本輸入 -->
                            <div class="bg-dark-700/50 rounded-2xl border border-accent-blue/20 p-6">
                                <label class="block text-sm font-medium text-gray-400 mb-3">輸入文字</label>
                                <textarea 
                                    id="embeddingInput" 
                                    rows="6"
                                    placeholder="輸入需要產生嵌入向量的文字..."
                                    class="input-field w-full px-4 py-3 rounded-xl text-white placeholder-gray-500 resize-none"
                                ></textarea>
                            </div>
                            
                            <!-- 生成按鈕 -->
                            <button id="generateEmbeddingBtn" class="btn-primary w-full py-4 rounded-xl font-semibold text-white flex items-center justify-center gap-2">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/>
                                </svg>
                                <span id="generateEmbeddingText">產生嵌入向量</span>
                                <div id="generateEmbeddingLoading" class="hidden loading-ring w-5 h-5 border-2"></div>
                            </button>
                            
                            <!-- 結果展示 -->
                            <div id="embeddingResult" class="hidden">
                                <div class="bg-dark-700/50 rounded-2xl border border-accent-blue/20 p-6">
                                    <div class="flex items-center justify-between mb-4">
                                        <h3 class="text-sm font-medium text-gray-400">嵌入結果</h3>
                                        <span id="embeddingDimensions" class="px-2 py-1 text-xs rounded-full bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30"></span>
                                    </div>
                                    <div class="embedding-result rounded-xl p-4 max-h-64 overflow-y-auto text-xs text-gray-400 break-all font-mono">
                                        <span id="embeddingData"></span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 全局錯誤提示 -->
                <div id="globalError" class="hidden absolute top-4 left-1/2 -translate-x-1/2 z-50">
                    <div class="bg-red-500/10 border border-red-500/30 text-red-400 px-6 py-3 rounded-xl flex items-center gap-3">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span id="globalErrorText"></span>
                    </div>
                </div>
            </main>
        </div>
    </div>
    
    <script>
        // ============ 全局狀態 ============
        let currentModel = null;
        let currentModelType = null;
        let chatHistory = [];
        let isStreaming = false;
        
        // ============ DOM 元素 ============
        const loginPage = document.getElementById('loginPage');
        const mainPage = document.getElementById('mainPage');
        const loginForm = document.getElementById('loginForm');
        const passwordInput = document.getElementById('passwordInput');
        const loginError = document.getElementById('loginError');
        const loginText = document.getElementById('loginText');
        const loginLoading = document.getElementById('loginLoading');
        const logoutBtn = document.getElementById('logoutBtn');
        const currentModelBadge = document.getElementById('currentModelBadge');
        const welcomeScreen = document.getElementById('welcomeScreen');
        const chatMode = document.getElementById('chatMode');
        const imageMode = document.getElementById('imageMode');
        const embeddingMode = document.getElementById('embeddingMode');
        const chatMessages = document.getElementById('chatMessages');
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const globalError = document.getElementById('globalError');
        const globalErrorText = document.getElementById('globalErrorText');
        
        // ============ 工具函數 ============
        function showError(element, message) {
            element.textContent = message;
            element.classList.remove('hidden');
            setTimeout(() => element.classList.add('hidden'), 5000);
        }
        
        function showGlobalError(message) {
            globalErrorText.textContent = message;
            globalError.classList.remove('hidden');
            setTimeout(() => globalError.classList.add('hidden'), 5000);
        }
        
        function setLoading(element, loading, textElement = null, loadingElement = null) {
            if (loading) {
                element.disabled = true;
                if (textElement) textElement.classList.add('hidden');
                if (loadingElement) loadingElement.classList.remove('hidden');
            } else {
                element.disabled = false;
                if (textElement) textElement.classList.remove('hidden');
                if (loadingElement) loadingElement.classList.add('hidden');
            }
        }
        
        function formatModelName(model) {
            const names = {
                '@cf/meta/llama-3.1-8b-instruct-fp8-fast': 'Llama-3.1-8B-Instruct',
                '@cf/meta/llama-4-scout-17b-16e-instruct': 'Llama-4-Scout-17B-Instruct',
                '@cf/mistralai/mistral-small-3.1-24b-instruct': 'Mistral-Small-3.1-24B-Instruct',
                '@cf/black-forest-labs/flux-2-dev': 'FLUX-2-Dev',
                '@cf/pfnet/plamo-embedding-1b': 'Plamo-Embedding'
            };
            return names[model] || model;
        }
        
        // ============ 登入/登出 ============
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = passwordInput.value.trim();
            if (!password) return;
            
            setLoading(document.querySelector('#loginForm button'), true, loginText, loginLoading);
            loginError.classList.add('hidden');
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    localStorage.setItem('cf_chatui_token', data.token);
                    loginPage.classList.add('hidden');
                    mainPage.classList.remove('hidden');
                    passwordInput.value = '';
                } else {
                    const data = await response.json();
                    showError(loginError, data.error || '密碼錯誤');
                }
            } catch (err) {
                showError(loginError, '網路錯誤，請稍後重試');
            } finally {
                setLoading(document.querySelector('#loginForm button'), false, loginText, loginLoading);
            }
        });
        
        logoutBtn.addEventListener('click', async () => {
            try {
                await fetch('/api/logout', { method: 'POST' });
                localStorage.removeItem('cf_chatui_token');
                mainPage.classList.add('hidden');
                loginPage.classList.remove('hidden');
                currentModel = null;
                currentModelType = null;
                chatHistory = [];
                chatMessages.innerHTML = '';
                resetAllModes();
            } catch (err) {
                showGlobalError('登出失敗');
            }
        });
        
        // ============ 模型選擇 ============
        
        // ============ 記憶模式 ============
        let memoryEnabled = true;
        let sessionId = localStorage.getItem('cf_chatui_session_id') || '';
        
        // 攔截登入響應以取得 sessionId
        const origLoginFetch = window.fetch;
        window.fetch = async function(url, opts) {
            const resp = await origLoginFetch(url, opts);
            if (url === '/api/login' && opts && opts.method === 'POST' && resp.ok) {
                const cloned = resp.clone();
                try {
                    const data = await cloned.json();
                    if (data.session_id) {
                        sessionId = data.session_id;
                        localStorage.setItem('cf_chatui_session_id', sessionId);
                    }
                } catch {}
            }
            return resp;
        };
        
        // 記憶模式開關
        document.getElementById('memoryToggle').addEventListener('change', async (e) => {
            memoryEnabled = e.target.checked;
            try {
                await apiFetch('/api/memory/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: memoryEnabled })
                });
            } catch {}
        });
        
        // 載入記憶開關狀態
        async function loadMemoryConfig() {
            try {
                const resp = await apiFetch('/api/memory/config');
                if (resp.ok) {
                    const data = await resp.json();
                    memoryEnabled = data.enabled !== false;
                    document.getElementById('memoryToggle').checked = memoryEnabled;
                }
            } catch {}
        }
        
        // 清除記錄
        document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
            if (!confirm('確定清除所有聊天記錄？此操作無法復原。')) return;
            try {
                const resp = await apiFetch('/api/memory/clear', { method: 'POST' });
                if (resp.ok) {
                    chatHistory = [];
                    chatMessages.innerHTML = '';
                    showGlobalError('聊天記錄已清除');
                }
            } catch (e) {
                showGlobalError('清除失敗：' + e.message);
            }
        });
        
        // 載入歷史
        document.getElementById('loadHistoryBtn').addEventListener('click', async () => {
            try {
                const resp = await apiFetch('/api/memory/history');
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.history && data.history.length > 0) {
                        chatHistory = data.history;
                        chatMessages.innerHTML = '';
                        for (const msg of chatHistory) {
                            const el = createMessageElement(msg.role, msg.content);
                            chatMessages.appendChild(el.div);
                        }
                        showGlobalError('已載入 ' + Math.floor(chatHistory.length / 2) + ' 輪對話記錄');
                    } else {
                        showGlobalError('沒有找到歷史記錄');
                    }
                }
            } catch (e) {
                showGlobalError('載入歷史失敗：' + e.message);
            }
        });
        
        // ============ Token 過期檢查 ============
        function isTokenExpired() {
            const token = localStorage.getItem('cf_chatui_token');
            if (!token) return true;
            try {
                const parts = token.split('.');
                if (parts.length !== 3) return true;
                const payload = JSON.parse(atob(parts[1]));
                return payload.exp * 1000 < Date.now();
            } catch { return true; }
        }
        
        function checkAuthAndRedirect() {
            if (isTokenExpired()) {
                localStorage.removeItem('cf_chatui_token');
                mainPage.classList.add('hidden');
                loginPage.classList.remove('hidden');
                showGlobalError('登入已過期，請重新登入');
                return false;
            }
            return true;
        }
        
        // ============ API 請求封裝（含超時與 Token 檢查） ============
        async function apiFetch(url, opts = {}) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            try {
                const token = localStorage.getItem('cf_chatui_token');
                if (token) {
                    opts.headers = opts.headers || {};
                    opts.headers['Authorization'] = 'Bearer ' + token;
                }
                opts.signal = controller.signal;
                if (!checkAuthAndRedirect()) throw new Error('登入已過期');
                const resp = await fetch(url, opts);
                if (resp.status === 401) {
                    checkAuthAndRedirect();
                    throw new Error('未授權，請重新登入');
                }
                return resp;
            } catch (err) {
                if (err.name === 'AbortError') {
                    showGlobalError('請求超時，請稍後再試');
                    throw new Error('請求超時');
                }
                throw err;
            } finally {
                clearTimeout(timeout);
            }
        }
        
        // 初始化載入記憶配置
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(loadMemoryConfig, 500);
        });

        document.querySelectorAll('.model-card').forEach(card => {
            card.addEventListener('click', () => {
                // 移除所有active狀態
                document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                
                // 更新當前模型
                currentModel = card.dataset.model;
                currentModelType = card.dataset.type;
                
                // 更新徽章
                currentModelBadge.textContent = formatModelName(currentModel);
                currentModelBadge.classList.remove('hidden');
                
                // 切換界面
                resetAllModes();
                welcomeScreen.classList.add('hidden');
                
                switch (currentModelType) {
                    case 'chat':
                        chatMode.classList.remove('hidden');
                        chatInput.focus();
                        break;
                    case 'image':
                        imageMode.classList.remove('hidden');
                        break;
                    case 'embedding':
                        embeddingMode.classList.remove('hidden');
                        break;
                }
            });
        });
        
        function resetAllModes() {
            welcomeScreen.classList.remove('hidden');
            chatMode.classList.add('hidden');
            imageMode.classList.add('hidden');
            embeddingMode.classList.add('hidden');
        }
        
        // ============ 對話功能 ============
        function createMessageElement(role, content = '', isStreaming = false) {
            const div = document.createElement('div');
            div.className = \`message flex gap-4 \${role === 'user' ? 'flex-row-reverse' : ''}\`;
            
            const avatar = document.createElement('div');
            avatar.className = \`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 \${
                role === 'user' 
                    ? 'bg-gradient-to-br from-accent-blue to-accent-cyan' 
                    : 'bg-gradient-to-br from-accent-purple to-accent-pink'
            }\`;
            avatar.innerHTML = role === 'user' 
                ? '<svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>'
                : '<svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>';
            
            const bubble = document.createElement('div');
            bubble.className = \`max-w-3xl p-4 rounded-2xl \${role === 'user' ? 'message-user rounded-tr-sm' : 'message-ai rounded-tl-sm'}\`;
            
            if (isStreaming) {
                bubble.innerHTML = \`
                    <div class="flex gap-1">
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                    </div>
                \`;
            } else {
                bubble.innerHTML = content ? marked.parse(content) : '';
            }
            
            div.appendChild(avatar);
            div.appendChild(bubble);
            
            return { div, bubble };
        }
        
        async function sendMessage() {
            const message = chatInput.value.trim();
            if (!message || isStreaming) return;
            
            // 添加用戶消息
            const userMsg = createMessageElement('user', message);
            chatMessages.appendChild(userMsg.div);
            chatInput.value = '';
            chatInput.style.height = 'auto';
            
            // 添加AI消息佔位
            const aiMsg = createMessageElement('ai', '', true);
            chatMessages.appendChild(aiMsg.div);
            
            // 滾動到底部
            chatMessages.scrollTop = chatMessages.scrollHeight;
            
            isStreaming = true;
            sendBtn.disabled = true;
            
            try {
                // 構建消息歷史
                const messages = [
                    { role: 'system', content: 'You are a helpful assistant. Please respond directly to the user without showing your reasoning process.' },
                    ...chatHistory,
                    { role: 'user', content: message }
                ];
                
                const token = localStorage.getItem('cf_chatui_token');
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({
                        model: currentModel,
                        messages: messages
                    })
                });
                
                if (!response.ok) {
                    const errorData = await response.text();
                    console.error('Chat API error:', errorData);
                    throw new Error('請求失敗: ' + response.status);
                }
                
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let fullResponse = '';
                
                // 移除loading動畫
                aiMsg.bubble.innerHTML = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6).trim();
                            if (dataStr === '[DONE]') continue;
                            
                            try {
                                const data = JSON.parse(dataStr);
                                // 相容標準 content 欄位與推理模型的 reasoning 欄位
                                const delta = data.choices?.[0]?.delta;
                                const content = delta?.content || delta?.reasoning || delta?.reasoning_content;
                                if (content) {
                                    fullResponse += content;
                                    aiMsg.bubble.innerHTML = marked.parse(fullResponse);
                                    chatMessages.scrollTop = chatMessages.scrollHeight;
                                    
                                    // 代碼高亮
                                    aiMsg.bubble.querySelectorAll('pre code').forEach(block => {
                                        hljs.highlightElement(block);
                                    });
                                }
                            } catch (e) {
                                // 忽略解析錯誤
                            }
                        }
                    }
                }
                
                // 保存歷史
                chatHistory.push({ role: 'user', content: message });
                chatHistory.push({ role: 'assistant', content: fullResponse });
                
                // 限制歷史長度
                if (chatHistory.length > 20) {
                    chatHistory = chatHistory.slice(-20);
                }
                
            } catch (err) {
                aiMsg.bubble.innerHTML = \`<span class="text-red-400">錯誤: \${err.message}</span>\`;
                showGlobalError('對話請求失敗，請稍後重試');
            } finally {
                isStreaming = false;
                sendBtn.disabled = false;
                chatInput.focus();
            }
        }
        
        sendBtn.addEventListener('click', sendMessage);
        
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 128) + 'px';
        });
        
        // ============ 圖片生成 ============
        const stepsInput = document.getElementById('stepsInput');
        const stepsValue = document.getElementById('stepsValue');
        const widthInput = document.getElementById('widthInput');
        const widthValue = document.getElementById('widthValue');
        const heightInput = document.getElementById('heightInput');
        const heightValue = document.getElementById('heightValue');
        const imagePrompt = document.getElementById('imagePrompt');
        const generateImageBtn = document.getElementById('generateImageBtn');
        const generateImageText = document.getElementById('generateImageText');
        const generateImageLoading = document.getElementById('generateImageLoading');
        const imagePreview = document.getElementById('imagePreview');
        
        stepsInput.addEventListener('input', () => {
            stepsValue.textContent = stepsInput.value;
        });
        
        widthInput.addEventListener('change', () => {
            widthValue.textContent = widthInput.value;
        });
        
        heightInput.addEventListener('change', () => {
            heightValue.textContent = heightInput.value;
        });
        
        generateImageBtn.addEventListener('click', async () => {
            const prompt = imagePrompt.value.trim();
            if (!prompt) {
                showGlobalError('請輸入提示詞');
                return;
            }
            
            setLoading(generateImageBtn, true, generateImageText, generateImageLoading);
            
            try {
                const token = localStorage.getItem('cf_chatui_token');
                const response = await fetch('/api/generate-image', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({
                        prompt: prompt,
                        steps: parseInt(stepsInput.value) || 25,
                        width: parseInt(widthInput.value) || 1024,
                        height: parseInt(heightInput.value) || 1024
                    })
                });
                
                if (!response.ok) {
                    throw new Error('產生失敗');
                }
                
                const data = await response.json();
                
                if (data.image) {
                    imagePreview.classList.add('has-image');
                    imagePreview.innerHTML = \`
                        <img src="\${data.image}" alt="Generated Image" class="max-w-full max-h-96 rounded-xl shadow-2xl">
                        <div class="absolute bottom-4 right-4">
                            <a href="\${data.image}" download="generated-image.png" class="btn-primary px-4 py-2 rounded-lg text-sm flex items-center gap-2">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                </svg>
                                下載
                            </a>
                        </div>
                    \`;
                }
            } catch (err) {
                showGlobalError('圖片生成失敗: ' + err.message);
            } finally {
                setLoading(generateImageBtn, false, generateImageText, generateImageLoading);
            }
        });
        
        // ============ 文本嵌入 ============
        const embeddingInput = document.getElementById('embeddingInput');
        const generateEmbeddingBtn = document.getElementById('generateEmbeddingBtn');
        const generateEmbeddingText = document.getElementById('generateEmbeddingText');
        const generateEmbeddingLoading = document.getElementById('generateEmbeddingLoading');
        const embeddingResult = document.getElementById('embeddingResult');
        const embeddingDimensions = document.getElementById('embeddingDimensions');
        const embeddingData = document.getElementById('embeddingData');
        
        generateEmbeddingBtn.addEventListener('click', async () => {
            const text = embeddingInput.value.trim();
            if (!text) {
                showGlobalError('請輸入文字');
                return;
            }
            
            setLoading(generateEmbeddingBtn, true, generateEmbeddingText, generateEmbeddingLoading);
            
            try {
                const token = localStorage.getItem('cf_chatui_token');
                const response = await fetch('/api/embeddings', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({
                        text: text
                    })
                });
                
                if (!response.ok) {
                    throw new Error('產生失敗');
                }
                
                const data = await response.json();
                
                if (data.embedding) {
                    embeddingResult.classList.remove('hidden');
                    embeddingDimensions.textContent = \`\${data.embedding.length} 維度\`;
                    
                    // 顯示部分數據
                    const displayData = data.embedding.slice(0, 100);
                    const remaining = data.embedding.length - 100;
                    embeddingData.textContent = JSON.stringify(displayData, null, 2) + 
                        (remaining > 0 ? \`\\n\\n... 還有 \${remaining} 個維度\` : '');
                }
            } catch (err) {
                showGlobalError('嵌入生成失敗: ' + err.message);
            } finally {
                setLoading(generateEmbeddingBtn, false, generateEmbeddingText, generateEmbeddingLoading);
            }
        });
        
        // ============ 初始化 ============
        document.addEventListener('DOMContentLoaded', () => {
            // 配置 marked
            marked.setOptions({
                highlight: function(code, lang) {
                    if (lang && hljs.getLanguage(lang)) {
                        return hljs.highlight(code, { language: lang }).value;
                    }
                    return hljs.highlightAuto(code).value;
                },
                breaks: true,
                gfm: true
            });
        });
    </script>
</body>
</html>
`;
}

// ============================================
// KV 記憶輔助函數
// ============================================

const MEMORY_PREFIX = 'memory:';
const MAX_HISTORY_ITEMS = 50;

async function getSessionIdFromRequest(request: Request, env: Env): Promise<string> {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
        const payload: JwtPayload = JSON.parse(payloadJson);
        if (payload.sub && payload.sub !== 'anonymous') return payload.sub;
      }
    } catch {}
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = request.headers.get('User-Agent') || 'unknown';
  const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ip + ua));
  const h = new Uint8Array(hashBuf);
  return 'anon-' + Array.from(h.slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// KV 未綁定時優雅降級（回傳空值/跳過操作），不影響主功能
async function loadKVHistory(sessionId: string, env: Env): Promise<string> {
  if (!env.CHAT_MEMORY) return '[]';
  try {
    return await env.CHAT_MEMORY.get(MEMORY_PREFIX + 'history:' + sessionId) || '[]';
  } catch (e) {
    console.error('KV 歷史讀取失敗:', e);
    return '[]';
  }
}

async function saveKVHistory(sessionId: string, messagesJson: string, env: Env): Promise<void> {
  if (!env.CHAT_MEMORY) return;
  try {
    const raw = await env.CHAT_MEMORY.get(MEMORY_PREFIX + 'history:' + sessionId);
    const arr: Array<{ ts: number; data: string }> = raw ? JSON.parse(raw) : [];
    arr.push({ ts: Date.now(), data: messagesJson });
    if (arr.length > MAX_HISTORY_ITEMS) arr.splice(0, arr.length - MAX_HISTORY_ITEMS);
    await env.CHAT_MEMORY.put(MEMORY_PREFIX + 'history:' + sessionId, JSON.stringify(arr));
  } catch (e) {
    console.error('KV 歷史儲存失敗:', e);
  }
}

async function clearKVHistory(sessionId: string, env: Env): Promise<void> {
  if (!env.CHAT_MEMORY) return;
  try {
    await env.CHAT_MEMORY.delete(MEMORY_PREFIX + 'history:' + sessionId);
  } catch (e) {
    console.error('KV 歷史刪除失敗:', e);
  }
}

async function loadMemoryConfig(sessionId: string, env: Env): Promise<boolean> {
  if (!env.CHAT_MEMORY) return false; // 未綁定 KV 時記憶模式預設關閉
  try {
    const v = await env.CHAT_MEMORY.get(MEMORY_PREFIX + 'config:' + sessionId);
    return v !== 'false';
  } catch { return true; }
}

async function saveMemoryConfig(sessionId: string, enabled: boolean, env: Env): Promise<void> {
  if (!env.CHAT_MEMORY) return;
  try {
    await env.CHAT_MEMORY.put(MEMORY_PREFIX + 'config:' + sessionId, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('KV 記憶配置儲存失敗:', e);
  }
}

// ============================================
// API 路由處理
// ============================================

async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body: LoginRequest = await request.json();
    
    if (!body.password) {
      return createErrorResponse('請提供密碼', 400);
    }
    
    // 驗證密碼
    if (body.password !== env.AUTH_PASSWORD) {
      return createErrorResponse('密碼錯誤', 401);
    }
    
    // 生成 JWT token (24小時有效)
    const token = await signJWT(
      { sub: 'user', exp: Math.floor(Date.now() / 1000) + 86400 },
      env.SESSION_SECRET
    );
    
    return createJSONResponse({ token, session_id: await getSessionIdFromRequest(request, env), message: '登入成功' });
  } catch {
    return createErrorResponse('請求格式錯誤', 400);
  }
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  // 客戶端負責刪除token，服務端可以記錄黑名單（可選）
  return createJSONResponse({ message: '登出成功' });
}

async function handleGetModels(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return createErrorResponse('未授權', 401);
  }
  
  return createJSONResponse(SUPPORTED_MODELS);
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return createErrorResponse('未授權', 401);
  }
  
  try {
    const body: ChatRequest = await request.json();
    
    if (!body.model || !body.messages || !Array.isArray(body.messages)) {
      return createErrorResponse('請提供模型和消息列表', 400);
    }
    
    // 驗證模型是否支持
    const supportedChatModels = SUPPORTED_MODELS.chat.map(m => m.id);
    if (!supportedChatModels.includes(body.model)) {
      return createErrorResponse('不支持的模型', 400);
    }
    
    const aiResponse = await callCloudflareAI(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      body.model,
      { messages: body.messages, stream: true }
    );
    
    if (!aiResponse.ok) {
      const errorData = await aiResponse.text();
      console.error('AI API Error:', errorData);
      return createErrorResponse('AI 服務調用失敗: ' + errorData, 500);
    }
    
    // 創建 SSE 流
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    
    // 處理流式響應
    const processStream = async () => {
      const reader = aiResponse.body?.getReader();
      if (!reader) {
        writer.close();
        return;
      }
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          // 直接轉發原始數據
          await writer.write(value);
        }
      } catch (err) {
        console.error('Stream error:', err);
      } finally {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        writer.close();
      }
      
      // 儲存對話記錄到 KV（如果記憶模式啟用）
      try {
        const sessionId = await getSessionIdFromRequest(request, env);
        const memConfig = await loadMemoryConfig(sessionId, env);
        if (memConfig && body.messages) {
          await saveKVHistory(sessionId, JSON.stringify(body.messages), env);
        }
      } catch (e) {
        console.error('Save history to KV error:', e);
      }
    };
    
    processStream();
    
    return new Response(readable, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    console.error('Chat error:', err);
    return createErrorResponse('處理請求時出錯', 500);
  }
}

async function handleGenerateImage(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return createErrorResponse('未授權', 401);
  }
  
  try {
    const body: GenerateImageRequest = await request.json();
    
    if (!body.prompt) {
      return createErrorResponse('請提供提示詞', 400);
    }
    
    const model = '@cf/black-forest-labs/flux-2-dev';
    
    // FLUX模型需要使用multipart/form-data格式
    const formData = new FormData();
    formData.append('prompt', body.prompt);
    formData.append('steps', String(body.steps || 25));
    formData.append('width', String(body.width || 1024));
    formData.append('height', String(body.height || 1024));
    
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
    
    const aiResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      },
      body: formData,
    });
    
    if (!aiResponse.ok) {
      const errorData = await aiResponse.text();
      console.error('Image API Error:', errorData);
      return createErrorResponse('圖片生成失敗: ' + errorData, 500);
    }
    
    // 解析響應獲取base64圖片
    const result = await aiResponse.json() as { result?: { image?: string } };
    const base64Image = result.result?.image;
    
    if (!base64Image) {
      return createErrorResponse('圖片生成返回格式錯誤', 500);
    }
    
    return createJSONResponse({
      image: `data:image/jpeg;base64,${base64Image}`,
      model,
    });
  } catch (err) {
    console.error('Image generation error:', err);
    return createErrorResponse('生成圖片時出錯', 500);
  }
}

async function handleEmbeddings(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return createErrorResponse('未授權', 401);
  }
  
  try {
    const body: EmbeddingsRequest = await request.json();
    
    if (!body.text) {
      return createErrorResponse('請提供文本', 400);
    }
    
    const model = '@cf/pfnet/plamo-embedding-1b';
    
    const aiResponse = await callCloudflareAI(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      model,
      { text: body.text }
    );
    
    if (!aiResponse.ok) {
      const errorData = await aiResponse.text();
      console.error('Embeddings API Error:', errorData);
      return createErrorResponse('嵌入產生失敗', 500);
    }
    
    const result = await aiResponse.json() as { result?: { data?: number[] } | number[] };
    const embedding = (result.result && 'data' in result.result) 
      ? result.result.data 
      : result.result;
    return createJSONResponse({
      embedding,
      model,
    });
  } catch (err) {
    console.error('Embeddings error:', err);
    return createErrorResponse('生成嵌入時出錯', 500);
  }
}

// ============================================
// 記憶模式 API 處理函數
// ============================================

async function handleMemoryHistory(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) return createErrorResponse('未授權', 401);
  try {
    const sessionId = await getSessionIdFromRequest(request, env);
    const raw = await loadKVHistory(sessionId, env);
    const arr = JSON.parse(raw);
    const history = arr.length > 0 ? JSON.parse(arr[arr.length - 1].data) : [];
    return createJSONResponse({ history });
  } catch (e) {
    console.error('Memory history error:', e);
    return createJSONResponse({ history: [] });
  }
}

async function handleMemoryClear(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) return createErrorResponse('未授權', 401);
  try {
    const sessionId = await getSessionIdFromRequest(request, env);
    await clearKVHistory(sessionId, env);
    return createJSONResponse({ message: '記憶已清除' });
  } catch (e) {
    return createErrorResponse('清除失敗', 500);
  }
}

async function handleMemoryConfigGet(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) return createErrorResponse('未授權', 401);
  try {
    const sessionId = await getSessionIdFromRequest(request, env);
    const enabled = await loadMemoryConfig(sessionId, env);
    return createJSONResponse({ enabled });
  } catch {
    return createJSONResponse({ enabled: true });
  }
}

async function handleMemoryConfigSet(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) return createErrorResponse('未授權', 401);
  try {
    const body = await request.json() as any;
    const sessionId = await getSessionIdFromRequest(request, env);
    await saveMemoryConfig(sessionId, !!body.enabled, env);
    return createJSONResponse({ message: '配置已更新' });
  } catch {
    return createErrorResponse('配置更新失敗', 400);
  }
}

// ============================================
// 主入口
// ============================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    
    // 處理 CORS 預檢請求
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    try {
      // 前端靜態頁面
      if (pathname === '/' && method === 'GET') {
        return new Response(getFrontendHTML(), {
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
          },
        });
      }
      
      // API 路由
      if (pathname === '/api/login' && method === 'POST') {
        return handleLogin(request, env);
      }
      
      if (pathname === '/api/logout' && method === 'POST') {
        return handleLogout(request, env);
      }
      
      if (pathname === '/api/models' && method === 'GET') {
        return handleGetModels(request, env);
      }
      
      if (pathname === '/api/chat' && method === 'POST') {
        return handleChat(request, env);
      }
      
      if (pathname === '/api/generate-image' && method === 'POST') {
        return handleGenerateImage(request, env);
      }
      
      if (pathname === '/api/embeddings' && method === 'POST') {
        return handleEmbeddings(request, env);
      }
      
      if (pathname === '/api/memory/history' && method === 'GET') {
        return handleMemoryHistory(request, env);
      }
      
      if (pathname === '/api/memory/clear' && method === 'POST') {
        return handleMemoryClear(request, env);
      }
      
      if (pathname === '/api/memory/config' && method === 'GET') {
        return handleMemoryConfigGet(request, env);
      }
      
      if (pathname === '/api/memory/config' && method === 'POST') {
        return handleMemoryConfigSet(request, env);
      }
      
      // 404
      return createErrorResponse('Not Found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return createErrorResponse('Internal Server Error', 500);
    }
  },
};
