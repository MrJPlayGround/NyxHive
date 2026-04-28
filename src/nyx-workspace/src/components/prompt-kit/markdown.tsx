import { marked } from 'marked'
import { createContext, memo, useContext, useId, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './code-block'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'

export type MarkdownProps = {
  children: string
  id?: string
  className?: string
  variant?: 'default' | 'inverse'
  components?: Partial<Components>
}

function parseMarkdownIntoBlocks(markdown: string): Array<string> {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

function extractLanguage(className?: string): string {
  if (!className) return 'text'
  const match = className.match(/language-(\w+)/)
  return match ? match[1] : 'text'
}

type TableRenderContextValue = {
  headersRef: React.MutableRefObject<Array<string>>
  columnIndexRef: React.MutableRefObject<number>
  collectingHeaderRef: React.MutableRefObject<boolean>
}

const TableRenderContext = createContext<TableRenderContextValue | null>(null)

function useTableRenderContext() {
  return useContext(TableRenderContext)
}

function textFromNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map((item: React.ReactNode) => textFromNode(item)).join('')
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as { props: { children?: React.ReactNode } }
    return textFromNode(element.props.children)
  }
  return ''
}

function slugifyHeading(children: React.ReactNode): string {
  const raw = textFromNode(children)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
  return raw.length > 0 ? raw : 'section'
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children }) {
    const isInline = !className?.includes('language-')

    if (isInline) {
      return (
        <code className="rounded bg-primary-100 px-1.5 py-0.5 text-[0.9em] font-mono text-primary-900 border border-primary-200">
          {children}
        </code>
      )
    }

    const language = extractLanguage(className)
    return (
      <CodeBlock
        content={String(children ?? '')}
        language={language}
        className="w-full my-2"
      />
    )
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },
  h1: function H1Component({ children }) {
    return (
      <h1 className="mt-5 mb-2 text-2xl leading-tight font-medium text-primary-950 text-balance first:mt-0">
        {children}
      </h1>
    )
  },
  h2: function H2Component({ children }) {
    const id = slugifyHeading(children)
    return (
      <h2
        id={id}
        className="mt-5 mb-2 text-xl leading-tight font-medium text-primary-950 text-balance first:mt-0"
      >
        <a
          href={`#${id}`}
          className="group/heading inline-flex items-center gap-1 no-underline"
        >
          <span>{children}</span>
          <span
            aria-hidden="true"
            className="text-primary-500 opacity-0 transition-opacity group-hover/heading:opacity-100"
          >
            #
          </span>
        </a>
      </h2>
    )
  },
  h3: function H3Component({ children }) {
    const id = slugifyHeading(children)
    return (
      <h3
        id={id}
        className="mt-4 mb-1.5 text-lg leading-tight font-medium text-primary-950 text-balance first:mt-0"
      >
        <a
          href={`#${id}`}
          className="group/heading inline-flex items-center gap-1 no-underline"
        >
          <span>{children}</span>
          <span
            aria-hidden="true"
            className="text-primary-500 opacity-0 transition-opacity group-hover/heading:opacity-100"
          >
            #
          </span>
        </a>
      </h3>
    )
  },
  h4: function H4Component({ children }) {
    return (
      <h4 className="mt-4 mb-1.5 text-base leading-tight font-medium text-primary-950 text-balance first:mt-0">
        {children}
      </h4>
    )
  },
  h5: function H5Component({ children }) {
    return (
      <h5 className="mt-3.5 mb-1 text-sm leading-tight font-medium text-primary-950 text-balance first:mt-0">
        {children}
      </h5>
    )
  },
  h6: function H6Component({ children }) {
    return (
      <h6 className="mt-3.5 mb-1 text-sm leading-tight font-medium text-primary-900 text-balance first:mt-0">
        {children}
      </h6>
    )
  },
  p: function PComponent({ children }) {
    return (
      <p className="text-primary-950 text-pretty leading-relaxed">{children}</p>
    )
  },
  ul: function UlComponent({ children }) {
    return (
      <ul className="ml-4 list-disc text-primary-950 marker:text-primary-400">
        {children}
      </ul>
    )
  },
  ol: function OlComponent({ children }) {
    return (
      <ol className="ml-4 list-decimal text-primary-950 marker:text-primary-500">
        {children}
      </ol>
    )
  },
  li: function LiComponent({ children }) {
    return <li className="leading-relaxed">{children}</li>
  },
  a: function AComponent({ children, href }) {
    return (
      <a
        href={href}
        className="text-primary-950 underline decoration-primary-300 underline-offset-4 transition-colors hover:text-primary-950 hover:decoration-primary-500"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    )
  },
  blockquote: function BlockquoteComponent({ children }) {
    return (
      <blockquote className="border-l-2 border-primary-300 pl-4 text-primary-900 italic">
        {children}
      </blockquote>
    )
  },
  strong: function StrongComponent({ children }) {
    return <strong className="font-medium text-primary-950">{children}</strong>
  },
  em: function EmComponent({ children }) {
    return <em className="italic text-primary-950">{children}</em>
  },
  hr: function HrComponent() {
    return <hr className="my-3 border-primary-200" />
  },
  table: function TableComponent({ children }) {
    const headersRef = useRef<Array<string>>([])
    const columnIndexRef = useRef(0)
    const collectingHeaderRef = useRef(false)
    return (
      <TableRenderContext.Provider
        value={{ headersRef, columnIndexRef, collectingHeaderRef }}
      >
        <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-primary-200 bg-primary-50/20">
          <table className="w-full min-w-max border-collapse text-sm sm:min-w-full tabular-nums">
            {children}
          </table>
        </div>
      </TableRenderContext.Provider>
    )
  },
  thead: function TheadComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      context.collectingHeaderRef.current = true
      context.columnIndexRef.current = 0
      context.headersRef.current = []
    }
    return (
      <thead className="sticky top-0 z-10 border-b border-primary-200 bg-primary-100/95 backdrop-blur-sm max-sm:hidden">
        {children}
      </thead>
    )
  },
  tbody: function TbodyComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      context.collectingHeaderRef.current = false
      context.columnIndexRef.current = 0
    }
    return (
      <tbody className="divide-y divide-primary-100 max-sm:block max-sm:divide-y-0">
        {children}
      </tbody>
    )
  },
  tr: function TrComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      context.columnIndexRef.current = 0
    }
    return (
      <tr className="odd:bg-primary-50/60 even:bg-primary-100/20 transition-colors hover:bg-primary-100/45 max-sm:mb-3 max-sm:block max-sm:overflow-hidden max-sm:rounded-lg max-sm:border max-sm:border-primary-200 max-sm:bg-primary-50">
        {children}
      </tr>
    )
  },
  th: function ThComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      const index = context.columnIndexRef.current
      context.columnIndexRef.current += 1
      if (context.collectingHeaderRef.current) {
        context.headersRef.current[index] = textFromNode(children).trim()
      }
    }
    return (
      <th className="px-3 py-2 text-left font-medium text-primary-950 whitespace-nowrap">
        {children}
      </th>
    )
  },
  td: function TdComponent({ children }) {
    const context = useTableRenderContext()
    let label = ''
    if (context) {
      const index = context.columnIndexRef.current
      context.columnIndexRef.current += 1
      label = context.headersRef.current[index] ?? `Column ${index + 1}`
    }
    return (
      <td
        data-label={label}
        className="px-3 py-2 text-primary-950 align-top max-sm:grid max-sm:grid-cols-[minmax(0,9rem)_1fr] max-sm:gap-3 max-sm:border-b max-sm:border-primary-100 max-sm:px-3 max-sm:py-2 max-sm:last:border-b-0 max-sm:before:content-[attr(data-label)] max-sm:before:text-xs max-sm:before:font-medium max-sm:before:text-primary-700"
      >
        {children}
      </td>
    )
  },
  tfoot: function TfootComponent({ children }) {
    return (
      <tfoot className="border-t border-primary-200 bg-primary-100/40">
        {children}
      </tfoot>
    )
  },
}

const INVERSE_COMPONENTS: Partial<Components> = {
  code: function InverseCodeComponent({ className, children }) {
    const isInline = !className?.includes('language-')

    if (isInline) {
      return (
        <code className="rounded border border-white/25 bg-white/15 px-1.5 py-0.5 font-mono text-[0.9em] text-white">
          {children}
        </code>
      )
    }

    const language = extractLanguage(className)
    return (
      <CodeBlock
        content={String(children ?? '')}
        language={language}
        className="w-full my-2"
      />
    )
  },
  h1: function InverseH1Component({ children }) {
    return (
      <h1 className="mt-5 mb-2 text-2xl leading-tight font-medium text-white text-balance first:mt-0">
        {children}
      </h1>
    )
  },
  h2: function InverseH2Component({ children }) {
    return (
      <h2 className="mt-5 mb-2 text-xl leading-tight font-medium text-white text-balance first:mt-0">
        {children}
      </h2>
    )
  },
  h3: function InverseH3Component({ children }) {
    return (
      <h3 className="mt-4 mb-1.5 text-lg leading-tight font-medium text-white text-balance first:mt-0">
        {children}
      </h3>
    )
  },
  h4: function InverseH4Component({ children }) {
    return (
      <h4 className="mt-4 mb-1.5 text-base leading-tight font-medium text-white text-balance first:mt-0">
        {children}
      </h4>
    )
  },
  h5: function InverseH5Component({ children }) {
    return (
      <h5 className="mt-3.5 mb-1 text-sm leading-tight font-medium text-white text-balance first:mt-0">
        {children}
      </h5>
    )
  },
  h6: function InverseH6Component({ children }) {
    return (
      <h6 className="mt-3.5 mb-1 text-sm leading-tight font-medium text-white/90 text-balance first:mt-0">
        {children}
      </h6>
    )
  },
  p: function InversePComponent({ children }) {
    return <p className="text-white text-pretty leading-relaxed">{children}</p>
  },
  ul: function InverseUlComponent({ children }) {
    return (
      <ul className="ml-4 list-disc text-white marker:text-white/55">
        {children}
      </ul>
    )
  },
  ol: function InverseOlComponent({ children }) {
    return (
      <ol className="ml-4 list-decimal text-white marker:text-white/65">
        {children}
      </ol>
    )
  },
  li: function InverseLiComponent({ children }) {
    return <li className="leading-relaxed text-white">{children}</li>
  },
  a: function InverseAComponent({ children, href }) {
    return (
      <a
        href={href}
        className="text-white underline decoration-white/55 underline-offset-4 transition-colors hover:decoration-white"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    )
  },
  blockquote: function InverseBlockquoteComponent({ children }) {
    return (
      <blockquote className="border-l-2 border-white/35 pl-4 text-white/90 italic">
        {children}
      </blockquote>
    )
  },
  strong: function InverseStrongComponent({ children }) {
    return <strong className="font-semibold text-white">{children}</strong>
  },
  em: function InverseEmComponent({ children }) {
    return <em className="italic text-white">{children}</em>
  },
  hr: function InverseHrComponent() {
    return <hr className="my-3 border-white/25" />
  },
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components,
  }: {
    content: string
    components: Partial<Components>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  function propsAreEqual(prevProps, nextProps) {
    return (
      prevProps.content === nextProps.content &&
      prevProps.components === nextProps.components
    )
  },
)

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock'

function MarkdownComponent({
  children,
  id,
  className,
  variant = 'default',
  components,
}: MarkdownProps) {
  const generatedId = useId()
  const blockId = id ?? generatedId
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children])
  const effectiveComponents = useMemo(() => {
    if (variant === 'inverse') {
      return { ...INITIAL_COMPONENTS, ...INVERSE_COMPONENTS, ...components }
    }
    return components
      ? { ...INITIAL_COMPONENTS, ...components }
      : INITIAL_COMPONENTS
  }, [components, variant])

  return (
    <div
      className={cn(
        'flex flex-col gap-2 break-words overflow-hidden',
        className,
      )}
    >
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={effectiveComponents}
        />
      ))}
    </div>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = 'Markdown'

export { Markdown }
