import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ReactElement } from "react";
import type { DevtoolsGraphNode } from "../api";
import { NodeLabel } from "./node-label";

export interface UnitFlowNodeData extends Record<string, unknown> {
  node: DevtoolsGraphNode;
}

export type UnitFlowNodeModel = Node<UnitFlowNodeData, "unit">;

export function UnitFlowNode(props: NodeProps): ReactElement {
  const data = props.data as UnitFlowNodeData;

  return (
    <div className="virentia-inspector__flow-node">
      <Handle
        className="virentia-inspector__handle"
        id="target"
        position={Position.Left}
        type="target"
      />
      <NodeLabel node={data.node} />
      <Handle
        className="virentia-inspector__handle"
        id="source"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}
