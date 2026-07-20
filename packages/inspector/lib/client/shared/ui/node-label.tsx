import { Box } from "@mantine/core";
import type { DevtoolsGraphNode } from "../api";
import type { ReactElement } from "react";

export function NodeLabel(props: { node: DevtoolsGraphNode }): ReactElement {
  const { name, type, key, meta } = props.node;

  return (
    <Box className="virentia-inspector__node-label">
      {/* Long names ellipsize inside the fixed-width card; the full value
          stays reachable through the native hover tooltip. */}
      <span className="virentia-inspector__node-name" title={name}>
        {name}
      </span>
      <span className="virentia-inspector__node-meta">
        <span className="virentia-inspector__node-type">{type}</span>
        {meta.factory ? (
          <span className="virentia-inspector__node-factory" title={`factory: ${meta.factory}`}>
            {meta.factory}
          </span>
        ) : null}
        {key ? <span className="virentia-inspector__node-key">key</span> : null}
      </span>
    </Box>
  );
}
