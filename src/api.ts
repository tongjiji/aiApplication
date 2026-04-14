import type { Message } from './types'

const ZHIPU_API_BASE_URL =
  import.meta.env.VITE_ZHIPU_API_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4'
const ZHIPU_API_KEY = import.meta.env.VITE_ZHIPU_API_KEY
const ZHIPU_CHAT_MODEL = import.meta.env.VITE_ZHIPU_CHAT_MODEL ?? 'glm-4-flash'
const ZHIPU_IMAGE_MODEL = import.meta.env.VITE_ZHIPU_IMAGE_MODEL ?? 'cogview-3-flash'

interface ZhipuDelta {
  content?: string
}

interface ZhipuChoice {
  delta?: ZhipuDelta
}

interface ZhipuChatStreamChunk {
  choices?: ZhipuChoice[]
}

type ImageSize = '1024x1024' | '1024x768' | '768x1024'
type ImageStyle =
  | 'realistic'
  | 'anime'
  | 'watercolor'
  | 'oil-painting'
  | 'cyberpunk'
  | 'pixel-art'
  | '3d-cartoon'
  | 'ink-sketch'
type ApiImageStyle = 'realistic' | 'anime'

const IMAGE_STYLE_LABELS: Record<ImageStyle, string> = {
  realistic: '写实',
  anime: '动漫',
  watercolor: '水彩',
  'oil-painting': '油画',
  cyberpunk: '赛博朋克',
  'pixel-art': '像素风',
  '3d-cartoon': '3D 卡通',
  'ink-sketch': '水墨素描',
}

function getApiImageStyle(style: ImageStyle): ApiImageStyle {
  switch (style) {
    case 'anime':
    case 'pixel-art':
    case '3d-cartoon':
      return 'anime'
    default:
      return 'realistic'
  }
}

interface GenerateImageParams {
  prompt: string
  size: ImageSize
  style: ImageStyle
}

interface ZhipuImageItem {
  url?: string
}

interface ZhipuImageResponse {
  data?: ZhipuImageItem[]
}

interface ZhipuChatCompletionChoice {
  message?: {
    content?: string
  }
}

interface ZhipuChatCompletionResponse {
  choices?: ZhipuChatCompletionChoice[]
}

export async function streamChatCompletion(
  messages: Message[],
  onToken: (token: string) => void,
): Promise<void> {
  if (!ZHIPU_API_KEY) {
    throw new Error('缺少环境变量 VITE_ZHIPU_API_KEY，请先在 .env 中配置。')
  }

  const response = await fetch(`${ZHIPU_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
    },
    body: JSON.stringify({
      model: ZHIPU_CHAT_MODEL,
      stream: true,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`智谱 API 请求失败（${response.status}）：${errorText}`)
  }

  if (!response.body) {
    throw new Error('未获取到流式响应数据。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue

      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue

      try {
        const chunk = JSON.parse(data) as ZhipuChatStreamChunk
        const token = chunk.choices?.[0]?.delta?.content
        if (token) onToken(token)
      } catch {
        // Ignore malformed chunks from network boundaries.
      }
    }
  }
}

export async function generateImage(params: GenerateImageParams): Promise<string> {
  if (!ZHIPU_API_KEY) {
    throw new Error('缺少环境变量 VITE_ZHIPU_API_KEY，请先在 .env 中配置。')
  }

  const response = await fetch(`${ZHIPU_API_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
    },
    body: JSON.stringify({
      model: ZHIPU_IMAGE_MODEL,
      prompt: params.prompt,
      size: params.size,
      style: getApiImageStyle(params.style),
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`图片生成失败（${response.status}）：${errorText}`)
  }

  const payload = (await response.json()) as ZhipuImageResponse
  const imageUrl = payload.data?.[0]?.url
  if (!imageUrl) {
    throw new Error('未获取到有效图片地址。')
  }

  return imageUrl
}

export async function optimizeImagePrompt(params: GenerateImageParams): Promise<string> {
  if (!ZHIPU_API_KEY) {
    throw new Error('缺少环境变量 VITE_ZHIPU_API_KEY，请先在 .env 中配置。')
  }

  const systemPrompt =
    '你是专业的 AI 绘画提示词工程师。请把用户的简短描述扩展成高质量图片生成提示词。输出必须包含主体、风格、光线、色彩、构图细节，语言精炼，不要加解释，不要使用项目符号。'
  const userPrompt = `原始描述：${params.prompt}\n目标尺寸：${params.size}\n风格偏好：${IMAGE_STYLE_LABELS[params.style]}`

  const response = await fetch(`${ZHIPU_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
    },
    body: JSON.stringify({
      model: ZHIPU_CHAT_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`提示词优化失败（${response.status}）：${errorText}`)
  }

  const payload = (await response.json()) as ZhipuChatCompletionResponse
  const optimizedPrompt = payload.choices?.[0]?.message?.content?.trim()
  if (!optimizedPrompt) {
    throw new Error('未获取到优化后的提示词。')
  }

  return optimizedPrompt
}
