import {
  LINGFLOW_INJECTED_ATTRIBUTE,
  LINGFLOW_SEGMENT_ATTRIBUTE,
  type ExtractReadableSegmentsOptions,
  type ReadableSegment,
} from '../types.js';

const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, dd, dt, td, th, figcaption';
const SKIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'textarea',
  'input',
  'button',
  'select',
  'option',
  'nav',
  'header',
  'footer',
  'aside',
  'code',
  'pre',
  'svg',
  'canvas',
  'iframe',
  '[hidden]',
  '[aria-hidden="true"]',
  '[role="button"]',
  '[role="navigation"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  `[${LINGFLOW_INJECTED_ATTRIBUTE}]`,
].join(',');

const CONTENT_ROOT_SELECTOR = [
  'article',
  'main',
  '[role="main"]',
  '.markdown-body',
  '.entry-content',
  '.post-content',
  '.article-content',
  '#readme',
].join(',');

export function extractReadableSegments(
  root: ParentNode = document.body,
  options: ExtractReadableSegmentsOptions = {},
): ReadableSegment[] {
  const minTextLength = options.minTextLength ?? 12;
  const maxSegments = options.maxSegments ?? 120;
  const scope = pickReadableScope(root);
  const elements = Array.from(scope.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const segments: ReadableSegment[] = [];
  const seen = new Set<HTMLElement>();

  for (const element of elements) {
    if (segments.length >= maxSegments) {
      break;
    }

    if (seen.has(element) || shouldSkipElement(element) || hasReadableBlockChild(element)) {
      continue;
    }

    const text = normalizeText(element.innerText || element.textContent || '');
    if (text.length < minTextLength) {
      continue;
    }

    const id = element.getAttribute(LINGFLOW_SEGMENT_ATTRIBUTE) || createSegmentId(segments.length);
    element.setAttribute(LINGFLOW_SEGMENT_ATTRIBUTE, id);
    seen.add(element);
    segments.push({ id, element, text });
  }

  return segments;
}

export function findReadableSegmentFromSelection(
  selection: Selection | null = document.getSelection(),
  fallbackText?: string,
) {
  if ((!selection || selection.rangeCount === 0 || selection.isCollapsed) && !fallbackText) {
    return undefined;
  }

  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const block = findNearestReadableBlock(element);
  if (!block || shouldSkipElement(block)) {
    return undefined;
  }

  const selectedText = normalizeText(selection?.toString() || fallbackText || '');
  const blockText = normalizeText(block.innerText || block.textContent || '');
  const text = selectedText || blockText;
  if (!text) {
    return undefined;
  }

  const id = block.getAttribute(LINGFLOW_SEGMENT_ATTRIBUTE) || createSegmentId(Date.now());
  block.setAttribute(LINGFLOW_SEGMENT_ATTRIBUTE, id);
  return { id, element: block, text };
}

function shouldSkipElement(element: HTMLElement) {
  if (element.closest(SKIP_SELECTOR)) {
    return true;
  }

  const style = window.getComputedStyle(element);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  );
}

function hasReadableBlockChild(element: HTMLElement) {
  return Array.from(element.children).some((child) => child.matches(BLOCK_SELECTOR));
}

function pickReadableScope(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(CONTENT_ROOT_SELECTOR)) {
    return root;
  }

  const scopes = Array.from(root.querySelectorAll<HTMLElement>(CONTENT_ROOT_SELECTOR)).filter(
    (element) => !shouldSkipElement(element),
  );

  if (scopes.length === 0) {
    return root;
  }

  return scopes
    .map((element) => ({
      element,
      score: normalizeText(element.innerText || element.textContent || '').length,
    }))
    .sort((left, right) => right.score - left.score)[0]?.element ?? root;
}

function findNearestReadableBlock(element?: Element | null) {
  let current: Element | null | undefined = element;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && current.matches(BLOCK_SELECTOR)) {
      return current;
    }

    current = current.parentElement;
  }

  current = element;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && !shouldSkipElement(current)) {
      const text = normalizeText(current.innerText || current.textContent || '');
      if (text.length > 0 && text.length < 2000) {
        return current;
      }
    }

    current = current.parentElement;
  }

  return undefined;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function createSegmentId(seed: number) {
  return `lf-${Date.now().toString(36)}-${seed.toString(36)}`;
}
