import type { TranslationResponse } from '@lingflow/core';
import {
  LINGFLOW_INJECTED_ATTRIBUTE,
  LINGFLOW_SEGMENT_ATTRIBUTE,
  type InjectBilingualTextOptions,
  type ReadableSegment,
} from '../types.js';

export function injectBilingualText(
  segment: ReadableSegment,
  translation: TranslationResponse,
  options: InjectBilingualTextOptions = {},
) {
  removeNearbyInjectedForNestedSegment(segment);
  removeInjectedForSegment(segment);

  if (options.mode === 'replace') {
    segment.element.textContent = translation.text;
    return segment.element;
  }

  const shouldNestBelow = options.mode !== 'inline' && shouldNestBelowInjection(segment.element);
  const node = document.createElement(options.mode === 'inline' || shouldNestBelow ? 'span' : 'div');
  node.setAttribute(LINGFLOW_INJECTED_ATTRIBUTE, 'true');
  node.setAttribute(LINGFLOW_SEGMENT_ATTRIBUTE, segment.id);
  node.className = options.className ?? 'lingflow-bilingual-text';
  node.textContent = options.mode === 'inline' ? ` ${translation.text}` : translation.text;
  if (options.mode === 'inline') {
    applyInlineStyle(node, segment.element);
    segment.element.append(node);
  } else if (shouldNestBelow) {
    applyNestedBelowStyle(node, segment.element);
    segment.element.append(node);
  } else {
    applyDefaultStyle(node, segment.element);
    segment.element.insertAdjacentElement('afterend', node);
  }
  return node;
}

export function cleanupLingFlow(root: ParentNode = document.body) {
  const nodes = root.querySelectorAll(`[${LINGFLOW_INJECTED_ATTRIBUTE}]`);
  nodes.forEach((node) => node.remove());
}

function removeInjectedForSegment(segment: ReadableSegment) {
  const selector = `[${LINGFLOW_INJECTED_ATTRIBUTE}][${LINGFLOW_SEGMENT_ATTRIBUTE}="${segment.id}"]`;
  segment.element.parentElement?.querySelectorAll(selector).forEach((node) => node.remove());
}

function removeNearbyInjectedForNestedSegment(segment: ReadableSegment) {
  const container = segment.element.closest('li, blockquote, dd, dt');
  if (!(container instanceof HTMLElement) || container === segment.element) {
    return;
  }

  container.querySelectorAll(`[${LINGFLOW_INJECTED_ATTRIBUTE}]`).forEach((node) => node.remove());

  let sibling = container.nextElementSibling;
  while (sibling?.hasAttribute(LINGFLOW_INJECTED_ATTRIBUTE)) {
    const next = sibling.nextElementSibling;
    sibling.remove();
    sibling = next;
  }
}

function applyDefaultStyle(node: HTMLElement, context: HTMLElement) {
  const theme = getInheritedTextTheme(context);
  node.style.margin = '0.35em 0 0.85em';
  node.style.padding = '0';
  node.style.border = '0';
  node.style.background = 'transparent';
  node.style.color = theme.text;
  node.style.fontFamily = theme.fontFamily;
  node.style.fontSize = theme.fontSize;
  node.style.fontWeight = theme.fontWeight;
  node.style.lineHeight = theme.lineHeight;
  node.style.letterSpacing = theme.letterSpacing;
  node.style.whiteSpace = 'normal';
  node.style.overflowWrap = 'anywhere';
  node.style.wordBreak = 'break-word';
  node.style.maxWidth = '100%';
  node.style.boxSizing = 'border-box';
  node.style.opacity = '0.86';
}

function applyNestedBelowStyle(node: HTMLElement, context: HTMLElement) {
  applyDefaultStyle(node, context);
  node.style.display = 'block';
  node.style.clear = 'both';
}

function applyInlineStyle(node: HTMLElement, context: HTMLElement) {
  const theme = getInheritedTextTheme(context);
  node.style.display = 'inline';
  node.style.margin = '0 0 0 0.35em';
  node.style.padding = '0';
  node.style.border = '0';
  node.style.borderRadius = '0';
  node.style.background = 'transparent';
  node.style.color = theme.text;
  node.style.fontFamily = theme.fontFamily;
  node.style.fontSize = theme.fontSize;
  node.style.fontWeight = theme.fontWeight;
  node.style.lineHeight = theme.lineHeight;
  node.style.letterSpacing = theme.letterSpacing;
  node.style.whiteSpace = 'normal';
  node.style.overflowWrap = 'anywhere';
  node.style.wordBreak = 'break-word';
  node.style.verticalAlign = 'baseline';
  node.style.opacity = '0.86';
}

function shouldNestBelowInjection(element: HTMLElement) {
  if (element.matches('p, span, strong, em, a')) {
    return true;
  }

  const parent = element.parentElement;
  if (!parent) {
    return false;
  }

  const parentStyle = window.getComputedStyle(parent);
  return parent.matches('li') || parentStyle.display.includes('flex') || parentStyle.display.includes('grid');
}

function getInheritedTextTheme(context: HTMLElement) {
  const style = window.getComputedStyle(context);
  return {
    text: style.color || 'currentColor',
    fontFamily: style.fontFamily || 'inherit',
    fontSize: style.fontSize || '1em',
    fontWeight: style.fontWeight || 'inherit',
    lineHeight: style.lineHeight || 'inherit',
    letterSpacing: style.letterSpacing || 'normal',
  };
}
