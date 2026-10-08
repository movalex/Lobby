// A tiny reader for React element trees, for the component tests (the web unit tests run in Node, without a
// DOM): it walks the elements a component returns, expanding function components that use no hooks, so a
// test can find a button by its test id and press it (call its `onClick`). A component that does use hooks
// is left as it is (a test of one renders its markup instead: react-dom/server).
import { isValidElement, type ReactElement, type ReactNode } from 'react'

type AnyProps = Record<string, unknown> & { children?: ReactNode }

/** Every element under `node` (the node itself included), depth first. */
export function elementsOf(node: ReactNode, expand = true): ReactElement<AnyProps>[] {
  const out: ReactElement<AnyProps>[] = []
  const visit = (n: ReactNode) => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c)
      return
    }
    if (!isValidElement(n)) return
    const el = n as ReactElement<AnyProps>
    out.push(el)
    if (expand && typeof el.type === 'function') {
      try {
        visit((el.type as (p: AnyProps) => ReactNode)(el.props))
        return
      } catch {
        // uses hooks: not expanded
      }
    }
    visit(el.props.children)
  }
  visit(node)
  return out
}

/** The elements with `data-testid` = `id`. */
export function byTestId(node: ReactNode, id: string): ReactElement<AnyProps>[] {
  return elementsOf(node).filter((e) => e.props['data-testid'] === id)
}

/** The text a tree shows (strings and numbers, in order). */
export function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isValidElement(node)) return ''
  const el = node as ReactElement<AnyProps>
  if (typeof el.type === 'function') {
    try {
      return textOf((el.type as (p: AnyProps) => ReactNode)(el.props))
    } catch {
      return textOf(el.props.children)
    }
  }
  return textOf(el.props.children)
}

/** Calls the `on<Event>` handler of an element (a click, a change), with a stand-in event. */
export function fire(el: ReactElement<AnyProps>, handler = 'onClick', event: unknown = {}): void {
  const fn = el.props[handler]
  if (typeof fn !== 'function') throw new Error(`no ${handler} on <${String(el.type)}>`)
  fn(event)
}
