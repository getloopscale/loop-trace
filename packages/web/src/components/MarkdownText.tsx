import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

/**
 * Render untrusted text as markdown, XSS-safe (M12 D4 / risk #2). `react-markdown`
 * builds a React element tree — it NEVER uses `dangerouslySetInnerHTML` — and
 * `rehype-sanitize` (default GitHub schema) strips `<script>`, event-handler
 * attributes, and `javascript:` URLs. This is the security guardrail: prompt /
 * response text from arbitrary agents is rendered inert by default.
 */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-text">
      <Markdown rehypePlugins={[rehypeSanitize]}>{text}</Markdown>
    </div>
  );
}
