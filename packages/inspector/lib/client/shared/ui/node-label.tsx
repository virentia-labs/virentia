import { Box, Tooltip } from "@mantine/core";
import type { DevtoolsGraphNode } from "../api";
import type { ReactElement } from "react";

export function NodeLabel(props: { node: DevtoolsGraphNode }): ReactElement {
  const { name, type, key, meta } = props.node;

  return (
    <Box className="virentia-inspector__node-label">
      {/* Long names ellipsize inside the fixed-width card; the full value
          stays reachable through the hover tooltip. */}
      <Tooltip label={name} openDelay={300} withinPortal>
        <span className="virentia-inspector__node-name">{name}</span>
      </Tooltip>
      <span className="virentia-inspector__node-meta">
        <span className="virentia-inspector__node-type">{type}</span>
        {meta.factory ? (
          <Tooltip label={`factory: ${meta.factory}`} openDelay={300} withinPortal>
            <span className="virentia-inspector__node-factory">{meta.factory}</span>
          </Tooltip>
        ) : null}
        {key ? <span className="virentia-inspector__node-key">key</span> : null}
      </span>
    </Box>
  );
}
