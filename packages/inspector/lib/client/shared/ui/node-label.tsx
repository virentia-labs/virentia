import { Box } from "@mantine/core";
import type { DevtoolsGraphNode } from "../api";
import type { ReactElement } from "react";

export function NodeLabel(props: { node: DevtoolsGraphNode }): ReactElement {
  return (
    <Box className="virentia-inspector__node-label">
      <span className="virentia-inspector__node-name">{props.node.name}</span>
      <span className="virentia-inspector__node-type">{props.node.type}</span>
    </Box>
  );
}
