// HTMi review tab for the Hermes dashboard. Plain JavaScript, no build step.
// It lists the review pages HTMi is running and shows the chosen one in a frame, at the
// document Hermes opened last. The page itself is served by `htmi serve` on 127.0.0.1;
// comments made in it are stored in the repository and reach Hermes on its next turn.
(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  const h = SDK.React.createElement;
  const { useEffect, useState, useCallback } = SDK.hooks;
  const { Card, CardHeader, CardTitle, CardContent, Button, Badge } = SDK.components;

  function Empty(props) {
    return h(
      Card,
      null,
      h(CardHeader, null, h(CardTitle, null, "No review page is running")),
      h(
        CardContent,
        { className: "space-y-2 text-sm text-muted-foreground" },
        h(
          "p",
          null,
          props.error ? "Could not list review pages: " + props.error : "Start one from a Hermes session in your repository:",
        ),
        h("p", null, h("code", null, "/htmi open docs/plan.html"), " or ask Hermes to open a document for review."),
        h(Button, { variant: "outline", size: "sm", onClick: props.onReload }, "Check again"),
      ),
    );
  }

  function ReviewPage() {
    const [servers, setServers] = useState(null);
    const [error, setError] = useState(null);
    const [chosen, setChosen] = useState(null);

    const load = useCallback(function () {
      SDK.fetchJSON("/api/plugins/htmi/servers")
        .then(function (data) {
          setError(null);
          setServers(data.servers || []);
        })
        .catch(function (e) {
          setError(String((e && e.message) || e));
          setServers([]);
        });
    }, []);

    useEffect(
      function () {
        load();
        const timer = setInterval(load, 5000);
        return function () {
          clearInterval(timer);
        };
      },
      [load],
    );

    if (servers === null) return h("p", { className: "text-sm text-muted-foreground" }, "Looking for review pages...");
    if (!servers.length) return h(Empty, { error: error, onReload: load });

    const current =
      servers.find(function (s) {
        return s.url === chosen;
      }) || servers[0];

    return h(
      "div",
      { className: "flex flex-col gap-3", style: { height: "calc(100vh - 140px)" } },
      h(
        "div",
        { className: "flex flex-wrap items-center gap-2" },
        servers.map(function (s) {
          return h(
            Button,
            {
              key: s.url,
              size: "sm",
              variant: s.url === current.url ? "default" : "outline",
              title: s.root,
              onClick: function () {
                setChosen(s.url);
              },
            },
            s.name,
          );
        }),
        h(Badge, { variant: "outline" }, "only this computer can reach it"),
        h(
          "a",
          { href: current.page || current.url + "/", target: "_blank", rel: "noreferrer", className: "text-sm underline ml-auto" },
          "Open in a new tab",
        ),
      ),
      h("iframe", {
        key: current.page || current.url,
        src: current.page || current.url + "/",
        title: "HTMi review of " + current.name,
        referrerPolicy: "no-referrer",
        className: "w-full flex-1 rounded-md border",
        style: { minHeight: "480px", background: "white" },
      }),
    );
  }

  window.__HERMES_PLUGINS__.register("htmi", ReviewPage);
})();
