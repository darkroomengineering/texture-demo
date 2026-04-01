import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from "react-router";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={{ margin: 0, padding: 0, background: "#0a0a0a" }}>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);

  const status = isResponse ? error.status : 500;
  const title = isResponse ? `${error.status} ${error.statusText}` : "Unexpected Error";
  const message = isResponse
    ? error.data
    : error instanceof Error
      ? error.message
      : "An unknown error occurred";
  const stack = error instanceof Error ? error.stack : undefined;

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "monospace",
        padding: "2rem",
        gap: "1.5rem",
        color: "#fff",
        background: "#0a0a0a",
      }}
    >
      <h1 style={{ fontSize: "4rem", margin: 0, lineHeight: 1 }}>{status}</h1>
      <p style={{ fontSize: "1.25rem", margin: 0, opacity: 0.7 }}>{title}</p>
      {message && typeof message === "string" && (
        <p style={{ margin: 0, opacity: 0.5, maxWidth: "40ch", textAlign: "center" }}>
          {message}
        </p>
      )}
      {process.env.NODE_ENV === "development" && stack && (
        <pre
          style={{
            background: "rgba(255, 0, 0, 0.05)",
            border: "1px solid rgba(255, 0, 0, 0.15)",
            borderRadius: "0.5rem",
            padding: "1rem",
            fontSize: "0.75rem",
            maxWidth: "80ch",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {stack}
        </pre>
      )}
      <a href="/" style={{ opacity: 0.7, textDecoration: "underline", color: "#fff" }}>
        Go Home
      </a>
    </div>
  );
}
