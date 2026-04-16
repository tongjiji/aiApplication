import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { generateImage, optimizeImagePrompt, streamChatCompletion } from '../api'
import type { Message } from '../types'

const initialMessages: Message[] = [
  {
    role: 'assistant',
    content:
      '你好，我是你的 AI 助手。可以问我任何问题，也支持 **Markdown**，例如：\n\n```ts\nconst hello = "world"\n```',
    timestamp: Date.now(),
  },
]

const CHAT_HISTORY_KEY = 'chatHistory'
const CHAT_CONVERSATIONS_KEY = 'chatConversations'
const IMAGE_HISTORY_KEY = 'imageHistory'

interface Conversation {
  id: string
  title: string
  updatedAt: number
  messages: Message[]
}

type AppPage = 'home' | 'chat' | 'image'
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

const IMAGE_STYLE_OPTIONS: ReadonlyArray<{ id: ImageStyle; label: string }> = [
  { id: 'realistic', label: '写实' },
  { id: 'anime', label: '动漫' },
  { id: 'watercolor', label: '水彩' },
  { id: 'oil-painting', label: '油画' },
  { id: 'cyberpunk', label: '赛博朋克' },
  { id: 'pixel-art', label: '像素风' },
  { id: '3d-cartoon', label: '3D 卡通' },
  { id: 'ink-sketch', label: '水墨素描' },
]

function getImageStyleLabel(style: ImageStyle): string {
  const matched = IMAGE_STYLE_OPTIONS.find((item) => item.id === style)
  return matched?.label ?? style
}

interface GeneratedImage {
  id: string
  url: string
  prompt: string
  size: ImageSize
  style: ImageStyle
  createdAt: number
}

function createConversationTitle(messages: Message[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim()
  if (!firstUserMessage) return '新对话'
  return firstUserMessage.length > 20 ? `${firstUserMessage.slice(0, 20)}...` : firstUserMessage
}

function createNewConversation(seedMessages: Message[] = initialMessages): Conversation {
  const now = Date.now()
  return {
    id: `conv-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: '新对话',
    updatedAt: now,
    messages: seedMessages,
  }
}

function sanitizeMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return initialMessages
  const safeMessages = raw.filter(
    (message): message is Message =>
      typeof message === 'object' &&
      message !== null &&
      ('role' in message &&
        ((message as Message).role === 'user' || (message as Message).role === 'assistant')) &&
      'content' in message &&
      typeof (message as Message).content === 'string' &&
      'timestamp' in message &&
      typeof (message as Message).timestamp === 'number',
  )
  return safeMessages.length > 0 ? safeMessages : initialMessages
}

function loadConversations(): Conversation[] {
  const rawConversations = localStorage.getItem(CHAT_CONVERSATIONS_KEY)
  if (rawConversations) {
    try {
      const parsed = JSON.parse(rawConversations) as Conversation[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .map((conversation) => ({
            id: conversation.id,
            title: conversation.title || '新对话',
            updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : Date.now(),
            messages: sanitizeMessages(conversation.messages),
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      }
    } catch {
      // Continue to fallback migration.
    }
  }

  const rawHistory = localStorage.getItem(CHAT_HISTORY_KEY)
  if (rawHistory) {
    try {
      const oldMessages = sanitizeMessages(JSON.parse(rawHistory))
      return [createNewConversation(oldMessages)]
    } catch {
      return [createNewConversation()]
    }
  }

  return [createNewConversation()]
}

function loadImageHistory(): GeneratedImage[] {
  const raw = localStorage.getItem(IMAGE_HISTORY_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as GeneratedImage[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item) =>
        typeof item.id === 'string' &&
        typeof item.url === 'string' &&
        typeof item.prompt === 'string' &&
        typeof item.createdAt === 'number',
    )
  } catch {
    return []
  }
}

export default function ChatInterface() {
  const initialConversationsRef = useRef<Conversation[] | null>(null)
  if (initialConversationsRef.current === null) {
    initialConversationsRef.current = loadConversations()
  }

  const [conversations, setConversations] = useState<Conversation[]>(
    () => initialConversationsRef.current ?? [createNewConversation()],
  )
  const [activeConversationId, setActiveConversationId] = useState<string>(
    () => initialConversationsRef.current?.[0]?.id ?? '',
  )
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null)
  const [errorNotice, setErrorNotice] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null)
  const [appPage, setAppPage] = useState<AppPage>('home')
  const [isPageTransitioning, setIsPageTransitioning] = useState(false)
  const [imagePrompt, setImagePrompt] = useState('')
  const [imageSize, setImageSize] = useState<ImageSize>('1024x1024')
  const [imageStyle, setImageStyle] = useState<ImageStyle>('realistic')
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false)
  const [isGeneratingImage, setIsGeneratingImage] = useState(false)
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>(() => loadImageHistory())
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null)
  const messagesContainerRef = useRef<HTMLElement | null>(null)

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  )
  const messages = activeConversation?.messages ?? initialMessages
  const canSend = useMemo(
    () => input.trim().length > 0 && !isLoading && Boolean(activeConversation),
    [input, isLoading, activeConversation],
  )

  useEffect(() => {
    localStorage.setItem(CHAT_CONVERSATIONS_KEY, JSON.stringify(conversations))
    localStorage.removeItem(CHAT_HISTORY_KEY)
  }, [conversations])

  useEffect(() => {
    localStorage.setItem(IMAGE_HISTORY_KEY, JSON.stringify(generatedImages))
  }, [generatedImages])

  useEffect(() => {
    if (activeConversationId) return
    if (conversations.length === 0) return
    setActiveConversationId(conversations[0].id)
  }, [activeConversationId, conversations])

  useEffect(() => {
    if (appPage !== 'chat') return
    const container = messagesContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [messages, isLoading, appPage])

  useEffect(() => {
    if (!errorNotice) return
    const timer = window.setTimeout(() => setErrorNotice(''), 3500)
    return () => window.clearTimeout(timer)
  }, [errorNotice])

  const navigateTo = (nextPage: AppPage) => {
    if (nextPage === appPage) return
    setIsPageTransitioning(true)
    window.setTimeout(() => {
      setAppPage(nextPage)
      requestAnimationFrame(() => setIsPageTransitioning(false))
    }, 140)
  }

  const handleSend = async () => {
    const content = input.trim()
    if (!content || isLoading || !activeConversation) return

    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      timestamp: Date.now() + 1,
    }
    const historyMessages = [...activeConversation.messages, userMessage]

    setConversations((prev) =>
      prev
        .map((conversation) =>
          conversation.id === activeConversation.id
            ? {
              ...conversation,
              messages: [...conversation.messages, userMessage, assistantMessage],
              title: createConversationTitle([...conversation.messages, userMessage]),
              updatedAt: Date.now(),
            }
            : conversation,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    )
    setInput('')
    setErrorNotice('')
    setStreamingMessageId(assistantMessage.timestamp)

    setIsLoading(true)
    try {
      await streamChatCompletion(historyMessages, (token) => {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id !== activeConversation.id
              ? conversation
              : {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.timestamp === assistantMessage.timestamp
                    ? { ...message, content: message.content + token }
                    : message,
                ),
                updatedAt: Date.now(),
              },
          ),
        )
      })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : '请求失败，请稍后重试。'
      setErrorNotice('请求失败，请检查网络或 API Key 后重试。')
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id !== activeConversation.id
            ? conversation
            : {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.timestamp === assistantMessage.timestamp
                  ? { ...message, content: `抱歉，暂时无法回答。\n\n错误信息：${errorMessage}` }
                  : message,
              ),
              updatedAt: Date.now(),
            },
        ),
      )
    } finally {
      setIsLoading(false)
      setStreamingMessageId(null)
    }
  }

  const handleClear = () => {
    if (isLoading || !activeConversation) return
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
            ...conversation,
            title: '新对话',
            messages: initialMessages,
            updatedAt: Date.now(),
          }
          : conversation,
      ),
    )
    setErrorNotice('')
  }

  const handleNewConversation = () => {
    if (isLoading) return
    const newConversation = createNewConversation()
    setConversations((prev) => [newConversation, ...prev])
    setActiveConversationId(newConversation.id)
    setInput('')
    setErrorNotice('')
  }

  const handleDeleteConversation = (conversationId: string) => {
    if (isLoading) return
    setConversations((prev) => {
      const next = prev.filter((conversation) => conversation.id !== conversationId)
      if (next.length === 0) {
        const fallback = createNewConversation()
        setActiveConversationId(fallback.id)
        return [fallback]
      }

      if (conversationId === activeConversationId) {
        setActiveConversationId(next[0].id)
      }
      return next
    })
    setErrorNotice('')
  }

  const handleOptimizePrompt = async () => {
    const prompt = imagePrompt.trim()
    if (!prompt) {
      setErrorNotice('请先输入图片描述，再进行提示词优化。')
      return
    }
    setIsOptimizingPrompt(true)
    setErrorNotice('')
    try {
      const optimizedPrompt = await optimizeImagePrompt({
        prompt,
        size: imageSize,
        style: imageStyle,
      })
      setImagePrompt(optimizedPrompt)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      setErrorNotice(`提示词优化失败，请稍后重试。${errorMessage}`)
    } finally {
      setIsOptimizingPrompt(false)
    }
  }

  const handleGenerateImage = async () => {
    const prompt = imagePrompt.trim()
    if (!prompt) {
      setErrorNotice('请输入图片描述后再生成。')
      return
    }

    setIsGeneratingImage(true)
    setErrorNotice('')
    try {
      const imageId = `img-${Date.now()}`
      const imageUrl = await generateImage({
        prompt,
        size: imageSize,
        style: imageStyle,
      })
      const newImage: GeneratedImage = {
        id: imageId,
        url: imageUrl,
        prompt,
        size: imageSize,
        style: imageStyle,
        createdAt: Date.now(),
      }
      setGeneratedImages((prev) => [newImage, ...prev])
      setSelectedImage(newImage)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      setErrorNotice(`图片生成失败，请稍后重试。${errorMessage}`)
    } finally {
      setIsGeneratingImage(false)
    }
  }

  const handleCopy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedMessageId(message.timestamp)
      window.setTimeout(() => setCopiedMessageId(null), 1500)
    } catch {
      setErrorNotice('复制失败，请手动选择文本复制。')
    }
  }

  const handleDeleteImage = (imageId: string) => {
    setGeneratedImages((prev) => prev.filter((image) => image.id !== imageId))
    if (selectedImage?.id === imageId) {
      setSelectedImage(null)
    }
  }

  const handleDownloadSelectedImage = async () => {
    if (!selectedImage) return
    try {
      const response = await fetch(selectedImage.url)
      if (!response.ok) {
        throw new Error(`下载失败（${response.status}）`)
      }
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = `ai-image-${Date.now()}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(blobUrl)
    } catch {
      setErrorNotice('图片下载失败，可能是图片地址不支持跨域下载。你可以尝试右键图片另存为。')
    }
  }

  const markdownComponents: Components = {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '')
      const code = String(children).replace(/\n$/, '')

      if (!match) {
        return (
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700" {...props}>
            {children}
          </code>
        )
      }

      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: '0.5rem 0', borderRadius: '0.5rem', padding: '0.75rem' }}
        >
          {code}
        </SyntaxHighlighter>
      )
    },
  }

  return (
    <div className="flex h-screen w-full overflow-x-auto bg-zinc-950 text-zinc-100">
      <div className="flex h-full w-[1200px] min-w-[1200px]">
        <aside
          className={`flex flex-col border-r border-zinc-800 bg-zinc-900/80 transition-all duration-300 ${appPage === 'home' ? 'w-0 overflow-hidden opacity-0' : 'w-80 opacity-100'
            }`}
        >
          {appPage === 'chat' ? (
            <>
              <div className="border-b border-zinc-800 p-3">
                <button
                  type="button"
                  onClick={handleNewConversation}
                  disabled={isLoading}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  + 新对话
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                <div className="mb-2 px-2 text-xs font-medium text-zinc-400">聊天历史</div>
                <div className="space-y-1">
                  {conversations.map((conversation) => {
                    const isActive = conversation.id === activeConversationId
                    return (
                      <div
                        key={conversation.id}
                        className={`group flex items-center gap-2 rounded-lg px-2 py-2 ${isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
                          }`}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveConversationId(conversation.id)}
                          className="flex-1 truncate text-left text-sm text-zinc-200"
                        >
                          {conversation.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteConversation(conversation.id)}
                          className="text-xs text-zinc-500 transition hover:text-zinc-200"
                        >
                          删除
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col">
              <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200">
                图片历史记录
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {generatedImages.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-400">
                    暂无图片历史
                  </div>
                ) : (
                  generatedImages.map((image) => (
                    <div
                      key={image.id}
                      className={`rounded-lg border p-2 ${selectedImage?.id === image.id
                        ? 'border-zinc-500 bg-zinc-800'
                        : 'border-zinc-700 bg-zinc-900'
                        }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedImage(image)}
                        className="w-full text-left"
                      >
                        <img
                          src={image.url}
                          alt={image.prompt}
                          className="mb-2 h-20 w-full rounded object-cover"
                        />
                        <p className="line-clamp-2 text-xs text-zinc-200">{image.prompt}</p>
                      </button>
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleDeleteImage(image.id)}
                          className="text-xs text-zinc-500 transition hover:text-zinc-200"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[56px] items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4">
            {appPage === 'home' ? (
              <div className="text-sm font-medium tracking-wide text-zinc-200">基尔 AI工作室</div>
            ) : (
              <div className="inline-flex rounded-lg border border-zinc-700 bg-zinc-900 p-1">
                <button
                  type="button"
                  onClick={() => navigateTo('home')}
                  className="rounded-md px-3 py-1.5 text-sm text-zinc-300 transition hover:text-white"
                >
                  返回首页
                </button>
                <button
                  type="button"
                  onClick={() => navigateTo('chat')}
                  className={`rounded-md px-3 py-1.5 text-sm transition ${appPage === 'chat'
                    ? 'bg-zinc-100 font-medium text-zinc-900'
                    : 'text-zinc-300 hover:text-white'
                    }`}
                >
                  聊天
                </button>
                <button
                  type="button"
                  onClick={() => navigateTo('image')}
                  className={`rounded-md px-3 py-1.5 text-sm transition ${appPage === 'image'
                    ? 'bg-zinc-100 font-medium text-zinc-900'
                    : 'text-zinc-300 hover:text-white'
                    }`}
                >
                  AI 图片生成器
                </button>
              </div>
            )}
            {appPage === 'chat' ? (
              <button
                type="button"
                onClick={handleClear}
                disabled={isLoading}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                清空当前对话
              </button>
            ) : (
              <div />
            )}
          </header>

          {errorNotice ? (
            <div className="mx-4 mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
              {errorNotice}
            </div>
          ) : null}

          <div
            className={`flex min-h-0 flex-1 flex-col transition-all duration-200 ${isPageTransitioning ? 'opacity-0 blur-[1px]' : 'opacity-100 blur-0'
              }`}
          >
            {appPage === 'home' ? (
              <main className="flex-1 overflow-y-auto p-8">
                <div className="home-ambient mx-auto max-w-5xl rounded-3xl">
                  <div className="home-ambient-dots" />
                  <div className="home-ambient-mesh" />
                  <div className="home-ambient-content">
                    <div className="enter-fade-up mb-10 rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-8">
                      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                        <div>
                          <p className="mb-3 text-xs font-medium tracking-[0.18em] text-zinc-400">
                            MINIMAL · BLACK · STUDIO
                          </p>
                          <h1 className="mb-3 text-4xl font-semibold tracking-tight text-white">
                            基尔 AI 工作台
                          </h1>
                          <p className="max-w-2xl text-sm leading-6 text-zinc-400">
                            统一的智能生产力入口：流式对话、Markdown 与代码高亮；文生图提示词优化、生成、历史与下载。
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => navigateTo('chat')}
                            className="rounded-xl border border-zinc-700 bg-zinc-100 px-5 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white focus-visible:ring-2 focus-visible:ring-zinc-500"
                          >
                            进入 AI 聊天
                          </button>
                          <button
                            type="button"
                            onClick={() => navigateTo('image')}
                            className="rounded-xl border border-zinc-700 bg-zinc-950 px-5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500"
                          >
                            进入 图片生成
                          </button>
                        </div>
                      </div>

                      <div className="mt-8 grid gap-3 sm:grid-cols-3">
                        {[
                          { k: '流式输出', v: '逐字呈现，更接近对话' },
                          { k: '多会话', v: '聊天历史独立管理' },
                          { k: '图片历史', v: '查看、删除、下载' },
                        ].map((item) => (
                          <div
                            key={item.k}
                            className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4"
                          >
                            <p className="text-sm font-medium text-white">{item.k}</p>
                            <p className="mt-1 text-xs leading-5 text-zinc-400">{item.v}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-6 md:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => navigateTo('chat')}
                        className="interactive-card enter-fade-up enter-delay-1 group rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-left transition hover:bg-zinc-800"
                      >
                        <div className="mb-4 flex items-center justify-between">
                          <p className="text-2xl font-medium text-white">AI 聊天</p>
                          <span className="text-xs text-zinc-400 transition group-hover:text-zinc-200">
                            打开 →
                          </span>
                        </div>
                        <p className="text-sm leading-6 text-zinc-400">
                          多轮上下文 + 流式输出，支持 Markdown 与代码高亮，适合问答、写作与技术讨论。
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {['流式', 'Markdown', '代码高亮', '本地保存'].map((t) => (
                            <span
                              key={t}
                              className="rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => navigateTo('image')}
                        className="interactive-card enter-fade-up enter-delay-2 group rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-left transition hover:bg-zinc-800"
                      >
                        <div className="mb-4 flex items-center justify-between">
                          <p className="text-2xl font-medium text-white">AI 图片生成</p>
                          <span className="text-xs text-zinc-400 transition group-hover:text-zinc-200">
                            打开 →
                          </span>
                        </div>
                        <p className="text-sm leading-6 text-zinc-400">
                          一键优化提示词，支持尺寸与风格选择，生成结果可查看大图、删除与下载。
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {['提示词优化', '尺寸/风格', '历史记录', '下载'].map((t) => (
                            <span
                              key={t}
                              className="rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </button>
                    </div>

                    <div className="mt-10 grid gap-6 md:grid-cols-2">
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
                        <p className="mb-2 text-sm font-medium text-white">使用流程</p>
                        <ol className="space-y-2 text-sm text-zinc-400">
                          <li className="flex gap-3">
                            <span className="mt-[2px] inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-200">
                              1
                            </span>
                            选择功能：AI 聊天或图片生成
                          </li>
                          <li className="flex gap-3">
                            <span className="mt-[2px] inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-200">
                              2
                            </span>
                            输入内容：问题或图片描述
                          </li>
                          <li className="flex gap-3">
                            <span className="mt-[2px] inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-200">
                              3
                            </span>
                            生成并管理：自动保存历史、可删除/下载
                          </li>
                        </ol>
                      </div>
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
                        <p className="mb-2 text-sm font-medium text-white">小贴士</p>
                        <div className="space-y-3 text-sm text-zinc-400">
                          <p>
                            - 图片描述建议包含：主体 + 场景 + 风格 + 光线 + 画面情绪
                          </p>
                          <p>- 想要更稳定的效果，先点击“优化提示词”再生成。</p>
                          <p>- 生成失败时请检查网络或 API Key 配置。</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </main>
            ) : appPage === 'chat' ? (
              <>
                <main ref={messagesContainerRef} className="flex-1 overflow-y-auto bg-zinc-950 px-4 py-4">
                  <div className="space-y-3">
                    {messages.map((message, index) => {
                      const isUser = message.role === 'user'
                      return (
                        <div
                          key={`${message.timestamp}-${index}`}
                          className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-6 shadow-sm ${isUser
                              ? 'rounded-br-sm bg-zinc-100 text-zinc-900'
                              : 'rounded-bl-sm border border-zinc-700 bg-zinc-900 text-zinc-100'
                              }`}
                          >
                            {!isUser && message.content ? (
                              <div className="mb-1 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => void handleCopy(message)}
                                  className="text-xs text-zinc-500 transition hover:text-zinc-200"
                                >
                                  {copiedMessageId === message.timestamp ? '已复制' : '复制'}
                                </button>
                              </div>
                            ) : null}
                            <div className="markdown-body break-words">
                              {message.timestamp === streamingMessageId ? (
                                <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                                  {message.content || '思考中...'}
                                </pre>
                              ) : (
                                <ReactMarkdown components={markdownComponents}>
                                  {message.content || (isLoading && !isUser ? '思考中...' : '')}
                                </ReactMarkdown>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </main>

                <footer className="border-t border-zinc-800 bg-zinc-950 px-4 py-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      disabled={isLoading}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void handleSend()
                        }
                      }}
                      rows={2}
                      placeholder="输入你的问题，Enter 发送，Shift+Enter 换行"
                      className="min-h-[48px] flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSend()}
                      disabled={!canSend}
                      className="h-[48px] shrink-0 whitespace-nowrap rounded-xl border border-zinc-700 bg-zinc-100 px-5 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 min-w-[84px]"
                    >
                      {isLoading ? '思考中...' : '发 送'}
                    </button>
                  </div>
                </footer>
              </>
            ) : (
              <main className="flex-1 overflow-y-auto bg-zinc-950 p-4">
                <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-200">图片描述</label>
                    <textarea
                      value={imagePrompt}
                      onChange={(event) => setImagePrompt(event.target.value)}
                      rows={3}
                      placeholder="例如：一只穿宇航服的橘猫在月球上弹吉他，电影级光影"
                      className="w-full resize-none rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-700"
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="mb-2 text-sm font-medium text-zinc-200">尺寸</p>
                      <div className="flex flex-wrap gap-2">
                        {(['1024x1024', '1024x768', '768x1024'] as const).map((size) => (
                          <button
                            key={size}
                            type="button"
                            onClick={() => setImageSize(size)}
                            className={`rounded-full border px-3 py-1.5 text-xs transition ${imageSize === size
                              ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
                              : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                              }`}
                          >
                            {size}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-2 text-sm font-medium text-zinc-200">风格</p>
                      <div className="flex flex-wrap gap-2">
                        {IMAGE_STYLE_OPTIONS.map((style) => (
                          <button
                            key={style.id}
                            type="button"
                            onClick={() => setImageStyle(style.id)}
                            className={`rounded-full border px-3 py-1.5 text-xs transition ${imageStyle === style.id
                              ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
                              : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                              }`}
                          >
                            {style.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleOptimizePrompt}
                      disabled={isGeneratingImage || isOptimizingPrompt}
                      className="rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-200 transition hover:bg-zinc-800"
                    >
                      {isOptimizingPrompt ? '优化中...' : '优化提示词'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleGenerateImage()}
                      disabled={isGeneratingImage || isOptimizingPrompt}
                      className="primary-action rounded-xl border border-zinc-200 bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
                    >
                      {isGeneratingImage ? '生成中...' : '生成图片'}
                    </button>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-2 text-sm font-medium text-zinc-200">图片展示区</div>
                  {isGeneratingImage ? (
                    <div className="mb-3 flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent" />
                      正在生成图片，请稍候...
                    </div>
                  ) : null}
                  {generatedImages.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
                      暂无生成图片，输入描述后点击“生成图片”开始创作。
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {selectedImage ? (
                        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
                          <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-zinc-100">当前图片</p>
                              <p className="truncate text-xs text-zinc-400">{selectedImage.prompt}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleDownloadSelectedImage()}
                              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white"
                            >
                              下载
                            </button>
                          </div>
                          <img
                            src={selectedImage.url}
                            alt={selectedImage.prompt}
                            className="max-h-[460px] w-full object-contain bg-zinc-950"
                          />
                          <div className="space-y-1 p-3 text-xs text-zinc-400">
                            <p className="text-sm text-zinc-200">{selectedImage.prompt}</p>
                            <p>尺寸：{selectedImage.size}</p>
                            <p>风格：{getImageStyleLabel(selectedImage.style)}</p>
                            <p>生成时间：{new Date(selectedImage.createdAt).toLocaleString()}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
                          点击左侧历史记录查看大图。
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </main>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
