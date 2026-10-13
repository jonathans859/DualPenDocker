import type * as monaco from "monaco-editor/editor/editor.api.js";

export interface OutlineViewCallbacks {
  getModel: () => monaco.editor.ITextModel | null;
  /** Called with the heading's current 1-based line after re-locating it. */
  onJump: (lineNumber: number) => void;
  announce: (message: string) => void;
}

interface Heading {
  level: number;
  title: string;
  /** 1-based line number at the time the outline was opened. */
  lineNumber: number;
  /** Exact line content, used to re-locate the heading after edits. */
  lineText: string;
}

interface HeadingNode {
  id: string;
  heading: Heading;
  children: HeadingNode[];
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

/** Scans markdown for ATX and setext headings, skipping fenced code blocks. */
export function parseHeadings(text: string): Heading[] {
  const lines = text.split(/\r\n|\r|\n/);
  const headings: Heading[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      // A closing fence uses the same character and is at least as long.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      headings.push({
        level: atx[1].length,
        title: atx[2]?.trim() || "(empty heading)",
        lineNumber: i + 1,
        lineText: line,
      });
      continue;
    }

    // Setext: a plain text line underlined by === (h1) or --- (h2).
    const next = lines[i + 1];
    if (line.trim() !== "" && next !== undefined && !/^ {4,}/.test(line)) {
      const underline = SETEXT_RE.exec(next);
      if (underline) {
        headings.push({
          level: underline[1][0] === "=" ? 1 : 2,
          title: line.trim(),
          lineNumber: i + 1,
          lineText: line,
        });
        i++; // the underline itself is not content
      }
    }
  }

  return headings;
}

/** Nests each heading under the nearest preceding heading of a lower level. */
function buildTree(headings: Heading[]): HeadingNode[] {
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  headings.forEach((heading, index) => {
    const node: HeadingNode = { id: String(index), heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}

/**
 * Finds the heading's current line by fanning out from where it was when the
 * outline opened: usually it hasn't moved, and searching nearest-first means
 * two headings with the same text don't get confused. Null if it's gone.
 */
export function findHeadingLine(model: monaco.editor.ITextModel, heading: Heading): number | null {
  const lineCount = model.getLineCount();
  const origin = heading.lineNumber;
  const maxDistance = Math.max(origin - 1, lineCount - origin);
  for (let d = 0; d <= maxDistance; d++) {
    const below = origin + d;
    if (below >= 1 && below <= lineCount && model.getLineContent(below) === heading.lineText) return below;
    const above = origin - d;
    if (d > 0 && above >= 1 && above <= lineCount && model.getLineContent(above) === heading.lineText) return above;
  }
  return null;
}

/**
 * Alt+O modal tree of the current document's headings, snapshotted when
 * opened. Same <dialog> + roving-tabindex pattern as presence-roster.ts, with
 * tree.ts's treeitem keyboard semantics. Enter or a click re-locates the
 * heading via findHeadingLine and jumps the editor cursor there.
 */
export class OutlineViewPanel {
  private callbacks: OutlineViewCallbacks;
  private dialog: HTMLDialogElement;
  private treeEl: HTMLElement;
  private expandAllEl: HTMLInputElement;
  private nodesById = new Map<string, HeadingNode>();
  private activeId: string | null = null;

  constructor(callbacks: OutlineViewCallbacks) {
    this.callbacks = callbacks;

    this.dialog = document.createElement("dialog");
    this.dialog.className = "outline-view-dialog";
    this.dialog.setAttribute("aria-labelledby", "outline-heading");
    this.dialog.innerHTML = `
      <h2 id="outline-heading">Outline</h2>
      <label class="outline-expand-all">
        <input type="checkbox" id="outline-expand-all" checked> Expand all
      </label>
      <ul id="outline-tree" class="outline-tree" role="tree" aria-labelledby="outline-heading"></ul>
      <div class="settings-buttons">
        <button type="button" id="outline-close-btn">Close</button>
      </div>
    `;
    document.body.appendChild(this.dialog);

    this.treeEl = this.dialog.querySelector<HTMLElement>("#outline-tree")!;
    this.expandAllEl = this.dialog.querySelector<HTMLInputElement>("#outline-expand-all")!;
    this.treeEl.addEventListener("keydown", (e) => this.handleKeydown(e));
    this.expandAllEl.addEventListener("change", () => this.setAllExpanded(this.expandAllEl.checked));
    this.dialog
      .querySelector<HTMLButtonElement>("#outline-close-btn")!
      .addEventListener("click", () => this.dialog.close());
  }

  open(): void {
    const model = this.callbacks.getModel();
    if (!model) {
      this.callbacks.announce("No document open.");
      return;
    }
    const headings = parseHeadings(model.getValue());
    if (headings.length === 0) {
      this.callbacks.announce("No headings in this document.");
      return;
    }

    const roots = buildTree(headings);
    this.nodesById.clear();
    this.treeEl.innerHTML = "";
    for (const node of roots) this.renderNode(node, this.treeEl, 1);
    this.expandAllEl.checked = true;

    if (!this.dialog.open) this.dialog.showModal();
    this.setActive(roots[0].id, true);
  }

  private renderNode(node: HeadingNode, parentEl: HTMLElement, level: number): void {
    this.nodesById.set(node.id, node);

    const li = document.createElement("li");
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-level", String(level));
    li.setAttribute("aria-selected", "false");
    li.dataset.nodeId = node.id;
    li.tabIndex = -1;

    const label = document.createElement("span");
    label.className = "outline-label";
    label.textContent = node.heading.title;
    li.appendChild(label);

    li.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setActive(node.id, true);
      this.activate(node);
    });

    if (node.children.length > 0) {
      li.setAttribute("aria-expanded", "true");
      const group = document.createElement("ul");
      group.setAttribute("role", "group");
      for (const child of node.children) this.renderNode(child, group, level + 1);
      li.appendChild(group);
    }

    parentEl.appendChild(li);
  }

  private getItemEl(id: string): HTMLLIElement | null {
    return this.treeEl.querySelector<HTMLLIElement>(`li[data-node-id="${id}"]`);
  }

  private getVisibleItems(): HTMLLIElement[] {
    return Array.from(this.treeEl.querySelectorAll<HTMLLIElement>('li[role="treeitem"]')).filter(
      (el) => !el.parentElement?.closest('ul[role="group"][hidden]'),
    );
  }

  private setActive(id: string, focus: boolean): void {
    this.activeId = id;
    for (const el of this.treeEl.querySelectorAll<HTMLLIElement>('li[role="treeitem"]')) {
      const isActive = el.dataset.nodeId === id;
      el.tabIndex = isActive ? 0 : -1;
      el.setAttribute("aria-selected", String(isActive));
      if (isActive && focus) el.focus();
    }
  }

  private setExpanded(li: HTMLLIElement, expanded: boolean): void {
    const group = li.querySelector<HTMLElement>(':scope > ul[role="group"]');
    if (!group) return;
    group.hidden = !expanded;
    li.setAttribute("aria-expanded", String(expanded));
  }

  private setAllExpanded(expanded: boolean): void {
    for (const li of this.treeEl.querySelectorAll<HTMLLIElement>("li[aria-expanded]")) {
      this.setExpanded(li, expanded);
    }
    // If the active item is now hidden, move the roving tabindex to its
    // top-level ancestor so Tab still reaches the tree. Focus is on the
    // checkbox here, so don't move it.
    const active = this.activeId ? this.getItemEl(this.activeId) : null;
    if (active && !this.getVisibleItems().includes(active)) {
      let top: HTMLLIElement = active;
      while (top.parentElement !== this.treeEl) {
        const parent = top.parentElement?.closest<HTMLLIElement>('li[role="treeitem"]');
        if (!parent) break;
        top = parent;
      }
      if (top.dataset.nodeId) this.setActive(top.dataset.nodeId, false);
    }
  }

  private activate(node: HeadingNode): void {
    const model = this.callbacks.getModel();
    const line = model ? findHeadingLine(model, node.heading) : null;
    if (line === null) {
      this.callbacks.announce("Heading not found — it may have been edited or removed.");
      return;
    }
    this.dialog.close();
    this.callbacks.onJump(line);
  }

  private handleKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLLIElement;
    if (!target || target.getAttribute("role") !== "treeitem") return;
    const node = target.dataset.nodeId ? this.nodesById.get(target.dataset.nodeId) : undefined;
    if (!node) return;

    const visible = this.getVisibleItems();
    const index = visible.indexOf(target);
    const moveTo = (el: HTMLLIElement | undefined) => {
      if (el?.dataset.nodeId) this.setActive(el.dataset.nodeId, true);
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(visible[index + 1]);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(visible[index - 1]);
        break;
      case "Home":
        e.preventDefault();
        moveTo(visible[0]);
        break;
      case "End":
        e.preventDefault();
        moveTo(visible[visible.length - 1]);
        break;
      case "ArrowRight": {
        e.preventDefault();
        if (node.children.length === 0) break;
        if (target.getAttribute("aria-expanded") === "false") {
          this.setExpanded(target, true);
        } else {
          moveTo(visible[index + 1]);
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (target.getAttribute("aria-expanded") === "true") {
          this.setExpanded(target, false);
        } else {
          moveTo(target.parentElement?.closest<HTMLLIElement>('li[role="treeitem"]') ?? undefined);
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        this.activate(node);
        break;
    }
  }
}
