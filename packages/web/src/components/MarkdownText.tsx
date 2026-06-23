import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { ReactNode } from "react";

/**
 * Embedded markdown must not define the PAGE heading outline (M19 a11y, FE-01):
 * a user prompt starting with `#` would otherwise inject an <h1> inside a span's
 * detail pane (which begins at <h2>/<h3>), producing a non-monotonic outline that
 * screen-reader rotor nav misreads. Demote every markdown heading to a styled,
 * non-heading paragraph — the visual emphasis stays, the document outline does not.
 */
function MdHeading({ children }: { children?: ReactNode }) {
  return <p className="md-heading">{children}</p>;
}

const COMPONENTS: Components = {
  h1: MdHeading,
  h2: MdHeading,
  h3: MdHeading,
  h4: MdHeading,
  h5: MdHeading,
  h6: MdHeading,
};

/**
 * Render untrusted text as markdown, XSS-safe (M12 D4 / risk #2). `react-markdown`
 * builds a React element tree — it NEVER uses `dangerouslySetInnerHTML` — and
 * `rehype-sanitize` (default GitHub schema) strips `<script>`, event-handler
 * attributes, and `javascript:` URLs. This is the security guardrail: prompt /
 * response text from arbitrary agents is rendered inert by default. Headings are
 * demoted (see MdHeading) so embedded content never hijacks the page outline.
 */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-text">
      <Markdown rehypePlugins={[rehypeSanitize]} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
