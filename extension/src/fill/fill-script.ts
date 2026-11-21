export interface FillRequest {
  origin: string;
  username: string | null;
  password: string | null;
}

export interface FillResult {
  filled: ("username" | "password")[];
  reason:
    | "filled"
    | "username-only"
    | "password-only"
    | "no-fields"
    | "new-password"
    | "hidden"
    | "origin"
    | "frame";
}

export function fillLogin(request: FillRequest): FillResult {
  if (window.top !== window) return { filled: [], reason: "frame" };
  if (location.origin !== request.origin) return { filled: [], reason: "origin" };

  const MIN_SIZE = 8;
  const MIN_OPACITY = 0.1;
  const TEXT_TYPES = new Set(["text", "email", "tel", ""]);

  const tokens = (input: HTMLInputElement): string[] =>
    (input.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter(Boolean);

  const inputs: HTMLInputElement[] = [];
  const walk = (root: Document | ShadowRoot): void => {
    const elements = root.querySelectorAll("*");
    for (const element of Array.from(elements)) {
      if (element instanceof HTMLInputElement) inputs.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);

  const ancestors = (element: Element): Element[] => {
    const chain: Element[] = [];
    let node: Node | null = element;
    while (node) {
      if (node instanceof Element) chain.push(node);
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return chain;
  };

  const inViewport = (rect: DOMRect): boolean =>
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth;

  const usable = (input: HTMLInputElement): boolean => {
    if (!input.isConnected || input.disabled || input.readOnly) return false;
    if (input.type === "hidden") return false;
    const chain = ancestors(input);
    let opacity = 1;
    for (const element of chain) {
      if (element.getAttribute("aria-hidden") === "true") return false;
      if (element.hasAttribute("inert") || element.hasAttribute("hidden")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (style.contentVisibility === "hidden") return false;

      const mask = style.maskImage || style.getPropertyValue("-webkit-mask-image");
      if (mask && mask !== "none") return false;
      for (const match of (style.filter || "").matchAll(/opacity\(([\d.]+)(%?)\)/g)) {
        opacity *= Number.parseFloat(match[1] ?? "1") / (match[2] ? 100 : 1);
      }
      opacity *= Number.parseFloat(style.opacity || "1");
    }
    if (!(opacity >= MIN_OPACITY)) return false;
    if (
      typeof input.checkVisibility === "function" &&
      !input.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    )
      return false;
    let rect = input.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false;
    if (!inViewport(rect)) {
      input.scrollIntoView({ block: "center", inline: "nearest" });
      rect = input.getBoundingClientRect();
      if (!inViewport(rect)) return false;
    }

    const root = input.getRootNode() as Document | ShadowRoot;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = root.elementFromPoint(x, y);
    return hit === input || (hit !== null && input.contains(hit));
  };

  const passwordFields = inputs.filter((input) => input.type === "password");
  const current = passwordFields.filter((input) => tokens(input).includes("current-password"));
  const fresh = passwordFields.filter((input) => tokens(input).includes("new-password"));
  const candidates = (current.length ? current : passwordFields).filter(
    (input) => !tokens(input).includes("new-password")
  );
  const passwordField = candidates.find(usable) ?? null;

  const isUsernameLike = (input: HTMLInputElement): boolean => {
    const auto = tokens(input);
    if (auto.includes("username") || auto.includes("email")) return true;
    if (!TEXT_TYPES.has(input.type)) return false;
    if (input.type === "email") return true;
    const hints = `${input.name} ${input.id} ${input.getAttribute("aria-label") || ""}`;
    return /user|email|e-mail|login|account|identifier/i.test(hints);
  };

  let usernameField: HTMLInputElement | null = null;
  if (request.username) {
    if (passwordField) {
      const form = passwordField.form;
      const before = inputs.filter(
        (input) =>
          input !== passwordField &&
          input.form === form &&
          passwordField.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING
      );

      const plausible = (input: HTMLInputElement): boolean =>
        form ? TEXT_TYPES.has(input.type) || input.type === "email" : isUsernameLike(input);
      usernameField =
        before.find((input) => {
          const auto = tokens(input);
          return (auto.includes("username") || auto.includes("email")) && usable(input);
        }) ??
        before.reverse().find((input) => plausible(input) && usable(input)) ??
        null;
    } else if (fresh.length === 0) {
      usernameField = inputs.find((input) => isUsernameLike(input) && usable(input)) ?? null;
    }
  }

  if (!passwordField && !usernameField) {
    if (fresh.length) return { filled: [], reason: "new-password" };
    const anyLoginField = passwordFields.length > 0 || inputs.some(isUsernameLike);
    if (anyLoginField) return { filled: [], reason: "hidden" };

    const framed = document.querySelector("iframe, frame") !== null;
    return { filled: [], reason: framed ? "frame" : "no-fields" };
  }

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const place = (input: HTMLInputElement, value: string): void => {
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const filled: FillResult["filled"] = [];
  if (usernameField && request.username) {
    place(usernameField, request.username);
    filled.push("username");
  }
  if (passwordField && request.password !== null) {
    place(passwordField, request.password);
    filled.push("password");
  }
  if (filled.length === 2) return { filled, reason: "filled" };
  if (filled[0] === "username") return { filled, reason: "username-only" };
  if (filled[0] === "password") return { filled, reason: "password-only" };
  return { filled, reason: "no-fields" };
}
