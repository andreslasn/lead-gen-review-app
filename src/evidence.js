// Prefer an email occurrence next to the selected provider/doctor when a page lists many clinics.
// Offsets always refer to source text; missing matches never manufacture evidence.
export function findEvidenceMatch(text, email, {quote = '', context = []} = {}) {
  const source=String(text||''), lower=source.toLowerCase(), needle=String(email||'').trim().toLowerCase();
  if(!needle)return null;
  const terms=context.map(v=>String(v||'').trim().toLowerCase()).filter(v=>v.length>=4);
  let best=null;
  for(let start=lower.indexOf(needle);start>=0;start=lower.indexOf(needle,start+needle.length)){
    const nearby=lower.slice(Math.max(0,start-400),start+needle.length+400);
    const score=terms.reduce((score,term)=>score+(nearby.includes(term)?1:0),0);
    if(!best||score>best.score)best={start,end:start+needle.length,score};
  }
  if(best)return {start:best.start,end:best.end};
  const excerpt=String(quote||'').trim();
  if(excerpt.length>=12){const start=lower.indexOf(excerpt.toLowerCase());if(start>=0)return {start,end:start+excerpt.length};}
  return null;
}

export function focusArchivedEvidence(frame, email, options = {}) {
      const document = frame?.contentDocument;
      const needle = String(email || "").trim().toLowerCase();
      if (!document?.body) return false;
      document.documentElement.style.setProperty("zoom", "1", "important");
      if (!document.getElementById("review-evidence-media-constraints")) {
        const style = document.createElement("style");
        style.id = "review-evidence-media-constraints";
        style.textContent = `
          html, body {
            background: #fff !important;
            color: #000 !important;
            font-family: Arial, Helvetica, sans-serif !important;
            font-size: 16px !important;
            line-height: 1.5 !important;
            margin: 0 !important;
          }
          body {
            padding: 16px !important;
          }
          body *, body *::before, body *::after {
            align-items: stretch !important;
            animation: none !important;
            background-color: transparent !important;
            background-image: none !important;
            box-shadow: none !important;
            clear: both !important;
            clip: auto !important;
            clip-path: none !important;
            color: #000 !important;
            columns: auto !important;
            column-gap: 0 !important;
            flex-direction: column !important;
            float: none !important;
            font-family: Arial, Helvetica, sans-serif !important;
            font-size: 16px !important;
            gap: 0 !important;
            grid-auto-flow: row !important;
            grid-template-columns: minmax(0, 1fr) !important;
            height: auto !important;
            inset: auto !important;
            letter-spacing: normal !important;
            line-height: 1.5 !important;
            margin: 0 !important;
            max-height: none !important;
            max-width: 100% !important;
            min-height: 0 !important;
            min-width: 0 !important;
            overflow: visible !important;
            padding: 0 !important;
            position: static !important;
            row-gap: 0 !important;
            justify-content: flex-start !important;
            text-shadow: none !important;
            text-overflow: clip !important;
            transform: none !important;
            transition: none !important;
            white-space: normal !important;
            width: auto !important;
            word-break: normal !important;
            z-index: auto !important;
            overflow-wrap: anywhere !important;
            -webkit-text-fill-color: #000 !important;
          }
          img, picture, svg, video, canvas, object, embed, iframe,
          source, track, input, textarea, select, button {
            display: none !important;
          }
          [data-review-dimmer] {
            background: rgba(0, 0, 0, 0.2) !important;
            display: block !important;
            inset: 0 !important;
            pointer-events: none !important;
            position: fixed !important;
            z-index: 2147483645 !important;
          }
          [data-review-email-highlight] {
            background: #fff36d !important;
            border-radius: 4px !important;
            box-shadow: 0 2px 10px rgba(255, 45, 125, 0.35) !important;
            color: #000 !important;
            outline: 3px solid #ff2d7d !important;
            outline-offset: 2px !important;
            padding: 1px 2px !important;
            position: relative !important;
            z-index: 2147483647 !important;
          }
          [data-review-proof-text] {
            display: block !important;
            white-space: pre-wrap !important;
          }
        `;
        (document.head || document.documentElement).append(style);
      }
      document.querySelectorAll("[data-review-dimmer], [data-review-spotlight]").forEach((element) => element.remove());
      for (const highlight of document.querySelectorAll("[data-review-email-highlight]")) {
        if (highlight.tagName === "MARK") {
          const parent = highlight.parentNode;
          highlight.replaceWith(...highlight.childNodes);
          parent?.normalize();
        } else {
          highlight.removeAttribute("data-review-email-highlight");
        }
      }
      if (document.body.dataset.reviewTextNormalized !== "true") {
        for (const element of document.querySelectorAll("[class*='cookie' i], [id*='cookie' i], [class*='consent' i], [id*='consent' i]")) {
          element.style.setProperty("display", "none", "important");
        }
        for (const element of document.querySelectorAll(`
          img, picture, svg, video, canvas, object, embed, iframe, source, track,
          input, textarea, select, button, noscript, template,
          [aria-busy='true'], [class*='skeleton' i], [class*='spinner' i],
          [class*='preloader' i], [class*='placeholder' i]
        `)) {
          element.remove();
        }
        const seenNavigation = new Set();
        for (const navigation of document.querySelectorAll("nav")) {
          const navigationText = String(navigation.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (!navigationText || seenNavigation.has(navigationText)) navigation.remove();
          else seenNavigation.add(navigationText);
        }
        let removedEmptyElement = true;
        while (removedEmptyElement) {
          removedEmptyElement = false;
          const elements = [...document.body.querySelectorAll("*")].reverse();
          for (const element of elements) {
            if (element.matches("script, style, link, meta, br, hr")) continue;
            const visibleText = String(element.textContent || "").replace(/\s+/g, "").trim();
            if (visibleText) continue;
            element.remove();
            removedEmptyElement = true;
          }
        }
        const normalizedText = String(document.body.innerText || document.body.textContent || "")
          .split(/\r?\n/)
          .map((line) => line.replace(/[\t ]+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
        const proofText = document.createElement("div");
        proofText.setAttribute("data-review-proof-text", "true");
        proofText.textContent = normalizedText;
        document.body.replaceChildren(proofText);
        document.body.dataset.reviewTextNormalized = "true";
      }
      if (!needle) return false;
      let target = null;
      let matchedRange = null;
      if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const value = String(node.nodeValue || "");
          const match = findEvidenceMatch(value, needle, options);
          if (!match) continue;
          const {start, end} = match;
          target = node.parentElement;
          matchedRange = document.createRange();
          matchedRange.setStart(node, start);
          matchedRange.setEnd(node, end);
          break;
        }
      }
      if (!target) {
        target = [...document.querySelectorAll("a")].find((element) =>
          `${element.textContent || ""} ${element.getAttribute("data-review-original-href") || ""}`.toLowerCase().includes(needle)
        );
      }
      if (!target) {
        target = [...document.querySelectorAll("*")].find((element) =>
          [...element.attributes].some((attribute) => String(attribute.value || "").toLowerCase().includes(needle))
        );
      }
      if (!target) return false;
      if (matchedRange) {
        const highlight = document.createElement("mark");
        highlight.setAttribute("data-review-email-highlight", "true");
        matchedRange.surroundContents(highlight);
        target = highlight;
      } else {
        target.setAttribute("data-review-email-highlight", "true");
      }
      const dimmer = document.createElement("div");
      dimmer.setAttribute("data-review-dimmer", "true");
      document.body.append(dimmer);
      document.body.style.setProperty("padding-bottom", `${Math.ceil(frame.clientHeight / 2)}px`, "important");
      target.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    }
