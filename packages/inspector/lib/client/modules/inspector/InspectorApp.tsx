import {
  Badge,
  Box,
  Button,
  Group,
  MantineProvider,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { scope } from "@virentia/core";
import {
  connectVirentiaInspector,
  emptySnapshot,
  type DevtoolsSnapshot,
  type DevtoolsTimelineEvent,
  type TriggerUnitResult,
  type VirentiaInspectorClient,
} from "../../shared/api";
import { ScopeProvider, useUnit } from "@virentia/react";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import {
  createFlowLayout,
  createReactiveSelection,
  type ReactiveSelection,
} from "../../shared/graph";
import { TimelineRow, UnitFlowNode, type UnitFlowNodeModel } from "../../shared/ui";
import { $recording, recordingChanged } from "./model";

export interface VirentiaInspectorProps {
  channel?: string;
}

const nodeTypes = {
  unit: UnitFlowNode,
} satisfies NodeTypes;

const rightPanelLimits = {
  default: 300,
  min: 210,
  max: 430,
};

type TriggerStage = "confirm" | "payload" | "result";

interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

export function VirentiaInspector(props: VirentiaInspectorProps): ReactElement {
  const inspectorScope = useMemo(() => scope(), []);

  return (
    <MantineProvider
      defaultColorScheme="dark"
      forceColorScheme="dark"
      theme={{ primaryColor: "green" }}
    >
      <ScopeProvider scope={inspectorScope}>
        <ReactFlowProvider>
          <InspectorSurface channel={props.channel} />
        </ReactFlowProvider>
      </ScopeProvider>
    </MantineProvider>
  );
}

function InspectorSurface(props: VirentiaInspectorProps): ReactElement {
  const [snapshot, setSnapshot] = useState<DevtoolsSnapshot>(emptySnapshot);
  const [timeline, setTimeline] = useState<DevtoolsTimelineEvent[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [breakpointIds, setBreakpointIds] = useState<string[]>([]);
  const [showIsolatedUnits, setShowIsolatedUnits] = useState(false);
  const [triggerNodeId, setTriggerNodeId] = useState<string | null>(null);
  const [triggerStage, setTriggerStage] = useState<TriggerStage | null>(null);
  const [triggerModalOpened, setTriggerModalOpened] = useState(false);
  const [payloadText, setPayloadText] = useState("");
  const [draftBreakpointIds, setDraftBreakpointIds] = useState<string[]>([]);
  const [breakpointSelectionActive, setBreakpointSelectionActive] = useState(false);
  const [triggerResult, setTriggerResult] = useState<TriggerUnitResult | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(rightPanelLimits.default);
  const recording = useUnit($recording);
  const setRecording = useUnit(recordingChanged);
  const clientRef = useRef<VirentiaInspectorClient | null>(null);
  const recordingRef = useRef(recording);
  const breakpointPickerInitialIdsRef = useRef<string[]>([]);
  const breakpointPickerReturnStageRef = useRef<TriggerStage>("payload");

  recordingRef.current = recording;

  useEffect(() => {
    const client = connectVirentiaInspector({
      channel: props.channel,
    });

    clientRef.current = client;
    const unsubscribe = client.subscribe((message) => {
      if (message.type === "app") {
        return;
      }

      if (message.type === "graph") {
        setSnapshot(message.snapshot);
        setBreakpointIds(message.snapshot.breakpoints);
        return;
      }

      if (message.type === "timeline" && recordingRef.current) {
        setTimeline((items) => [message.event, ...items].slice(0, 300));
      }
    });

    client.requestGraph();

    return () => {
      unsubscribe();
      client.dispose();
      clientRef.current = null;
    };
  }, [props.channel]);

  const visibleSnapshot = useMemo(
    () => (showIsolatedUnits ? snapshot : hideIsolatedNodes(snapshot)),
    [showIsolatedUnits, snapshot],
  );
  const selectedFlow = useMemo(
    () =>
      createReactiveSelection(
        visibleSnapshot,
        breakpointSelectionActive ? triggerNodeId : selectedNodeId,
      ),
    [breakpointSelectionActive, selectedNodeId, triggerNodeId, visibleSnapshot],
  );
  const breakpointEligibleNodeIds = useMemo(
    () => new Set(selectedFlow?.nodeIds ?? []),
    [selectedFlow],
  );
  const draftBreakpointIdSet = useMemo(() => new Set(draftBreakpointIds), [draftBreakpointIds]);
  const flow = useFlowGraph(visibleSnapshot, selectedFlow, {
    breakpointIds: draftBreakpointIdSet,
    breakpointSelectionActive,
    eligibleNodeIds: breakpointEligibleNodeIds,
  });
  const triggerNode = useMemo(
    () => snapshot.nodes.find((node) => node.id === triggerNodeId) ?? null,
    [snapshot.nodes, triggerNodeId],
  );
  const selectedBreakpointNodes = useMemo(
    () =>
      draftBreakpointIds.flatMap((id) => {
        const node = snapshot.nodes.find((item) => item.id === id);

        return node ? [node] : [];
      }),
    [draftBreakpointIds, snapshot.nodes],
  );
  const breakpointSummary = selectedBreakpointNodes.length ? (
    <Group gap={4} mt={6}>
      {selectedBreakpointNodes.map((node) => (
        <Badge color="red" key={node.id} size="xs" variant="light">
          {node.name}
        </Badge>
      ))}
    </Group>
  ) : (
    <Text size="xs" c="dimmed" mt={6}>
      None selected
    </Text>
  );
  const shellStyle = useMemo(
    () =>
      ({
        "--virentia-right-panel-width": `${rightPanelWidth}px`,
      }) as CSSProperties,
    [rightPanelWidth],
  );

  useEffect(() => {
    if (selectedNodeId && !visibleSnapshot.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, visibleSnapshot.nodes]);

  const beginDrawerResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = rightPanelWidth;

      const move = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = startWidth - delta;

        setRightPanelWidth(
          Math.min(rightPanelLimits.max, Math.max(rightPanelLimits.min, nextWidth)),
        );
      };

      const end = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
    },
    [rightPanelWidth],
  );

  const updateBreakpoints = (nodeIds: string[]): void => {
    setBreakpointIds(nodeIds);
    clientRef.current?.setBreakpoints(nodeIds);
  };

  const openTriggerModal = (nodeId: string): void => {
    setContextMenu(null);
    setTriggerNodeId(nodeId);
    setPayloadText("");
    setDraftBreakpointIds([]);
    setTriggerResult(null);
    setTriggerError(null);
    setTriggerStage("payload");
    setTriggerModalOpened(true);
  };

  const resetTriggerFlow = (): void => {
    setTriggerNodeId(null);
    setTriggerStage(null);
    setTriggerModalOpened(false);
    setPayloadText("");
    setDraftBreakpointIds([]);
    setBreakpointSelectionActive(false);
    setTriggerResult(null);
    setTriggerError(null);
  };

  const requestCloseTriggerFlow = (): void => {
    setTriggerModalOpened(false);
    setBreakpointSelectionActive(false);
  };

  const handleTriggerModalExited = (): void => {
    if (!breakpointSelectionActive && !triggerModalOpened) {
      resetTriggerFlow();
    }
  };

  const parsePayload = (): { ok: true; payload: unknown } | { ok: false } => {
    try {
      const payload = payloadText.trim() ? JSON.parse(payloadText) : undefined;

      setTriggerError(null);
      return { ok: true, payload };
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error));
      return { ok: false };
    }
  };

  const acceptPayload = (): void => {
    if (!parsePayload().ok) {
      return;
    }

    setTriggerStage("confirm");
  };

  const startBreakpointSelection = (): void => {
    if (!triggerNodeId || !parsePayload().ok) {
      return;
    }

    breakpointPickerInitialIdsRef.current = draftBreakpointIds;
    breakpointPickerReturnStageRef.current = triggerStage ?? "payload";
    setTriggerResult(null);
    setTriggerModalOpened(false);
    setBreakpointSelectionActive(true);
    setSelectedNodeId(triggerNodeId);
  };

  const finishBreakpointSelection = (accepted: boolean): void => {
    if (!accepted) {
      setDraftBreakpointIds(breakpointPickerInitialIdsRef.current);
    }

    setBreakpointSelectionActive(false);
    setTriggerStage(breakpointPickerReturnStageRef.current);
    setTriggerModalOpened(true);
  };

  const triggerSelectedNode = async (): Promise<void> => {
    if (!triggerNodeId) {
      return;
    }

    const parsed = parsePayload();

    if (!parsed.ok) {
      return;
    }

    const previousBreakpoints = breakpointIds;
    const scopeId = snapshot.scopes[0]?.id ?? null;

    updateBreakpoints(draftBreakpointIds);

    const result = await clientRef.current?.triggerUnit({
      nodeId: triggerNodeId,
      scopeId,
      payload: parsed.payload,
    });

    updateBreakpoints(previousBreakpoints);
    setTriggerResult(result ?? { ok: false });
    setTriggerStage("result");
  };

  const handleNodeClick: NodeMouseHandler<UnitFlowNodeModel> = (_, node): void => {
    setContextMenu(null);

    if (breakpointSelectionActive) {
      if (!breakpointEligibleNodeIds.has(node.id)) {
        return;
      }

      setDraftBreakpointIds((ids) =>
        ids.includes(node.id) ? ids.filter((id) => id !== node.id) : [...ids, node.id],
      );
      return;
    }

    setSelectedNodeId(node.id);
  };

  const handleNodeContextMenu: NodeMouseHandler<UnitFlowNodeModel> = (event, node): void => {
    event.preventDefault();

    if (breakpointSelectionActive) {
      return;
    }

    setSelectedNodeId(node.id);
    setContextMenu({
      nodeId: node.id,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <Box className="virentia-inspector">
      <Box className="virentia-inspector__shell" style={shellStyle}>
        <Box className="virentia-inspector__main">
          <Box className="virentia-inspector__topbar">
            <Group gap="xs" wrap="nowrap">
              <Title order={4}>Virentia</Title>
            </Group>
            <Group gap="xs">
              <Switch
                checked={showIsolatedUnits}
                color="green"
                label="Show isolated"
                onChange={(event) => setShowIsolatedUnits(event.currentTarget.checked)}
                size="xs"
              />
              <Badge color={visibleSnapshot.nodes.length ? "green" : "gray"} variant="light">
                {visibleSnapshot.nodes.length} units
              </Badge>
              <Badge variant="light" color="gray">
                {visibleSnapshot.edges.length} links
              </Badge>
              {breakpointIds.length ? (
                <Badge variant="light" color="red">
                  {breakpointIds.length} breakpoints
                </Badge>
              ) : null}
            </Group>
            <Button
              color="green"
              size="xs"
              variant="light"
              onClick={() => clientRef.current?.requestGraph()}
            >
              Refresh
            </Button>
          </Box>

          <Box className="virentia-inspector__flow">
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              fitView
              nodeTypes={nodeTypes}
              minZoom={0.15}
              onNodeClick={handleNodeClick}
              onNodeContextMenu={handleNodeContextMenu}
              onPaneClick={() => {
                setContextMenu(null);

                if (!breakpointSelectionActive) {
                  setSelectedNodeId(null);
                }
              }}
            >
              <Background gap={18} color="#424242" />
              <Controls />
            </ReactFlow>
          </Box>
        </Box>

        <Stack className="virentia-inspector__drawer" gap="sm" p="sm">
          <button
            aria-label="Resize tools panel"
            className="virentia-inspector__resize-handle virentia-inspector__resize-handle--right"
            onPointerDown={beginDrawerResize}
            type="button"
          />
          <Group justify="space-between">
            <Text fw={650} size="sm">
              Call history
            </Text>
            <Group gap="xs">
              <Switch
                checked={recording}
                color="green"
                label="Record"
                onChange={(event) => setRecording(event.currentTarget.checked)}
                size="xs"
              />
              <Button color="gray" size="xs" variant="subtle" onClick={() => setTimeline([])}>
                Clear
              </Button>
            </Group>
          </Group>
          <ScrollArea h="calc(100vh - 66px)" type="auto">
            {timeline.map((item) => (
              <TimelineRow event={item} key={item.id} />
            ))}
          </ScrollArea>
        </Stack>
      </Box>

      {contextMenu ? (
        <Paper
          className="virentia-inspector__context-menu"
          shadow="md"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          withBorder
        >
          <button
            className="virentia-inspector__context-menu-item"
            onClick={() => openTriggerModal(contextMenu.nodeId)}
            type="button"
          >
            Trigger unit
          </button>
        </Paper>
      ) : null}

      {breakpointSelectionActive ? (
        <Box className="virentia-inspector__bottom-toolbar">
          <Box>
            <Text fw={650} size="sm">
              Select breakpoints
            </Text>
            <Text size="xs" c="dimmed">
              Only units from the {triggerNode?.name ?? ""} chain are available
            </Text>
          </Box>
          <Group gap="xs">
            <Button
              color="gray"
              size="xs"
              variant="subtle"
              onClick={() => finishBreakpointSelection(false)}
            >
              Cancel
            </Button>
            <Button color="green" size="xs" onClick={() => finishBreakpointSelection(true)}>
              Apply
            </Button>
          </Group>
        </Box>
      ) : null}

      <Modal
        centered
        classNames={{
          body: "virentia-inspector__modal-body",
          content: "virentia-inspector__modal-content",
          header: "virentia-inspector__modal-header",
          title: "virentia-inspector__modal-title",
        }}
        opened={triggerModalOpened && triggerStage !== null}
        onClose={requestCloseTriggerFlow}
        onExitTransitionEnd={handleTriggerModalExited}
        padding="sm"
        radius="sm"
        size={420}
        title={triggerNode ? `Trigger: ${triggerNode.name}` : "Trigger unit"}
      >
        {triggerStage === "payload" ? (
          <Stack gap="xs">
            <Textarea
              autosize
              minRows={5}
              label="Payload JSON"
              size="xs"
              value={payloadText}
              onChange={(event) => setPayloadText(event.currentTarget.value)}
            />
            {triggerError ? (
              <Text size="xs" c="red">
                {triggerError}
              </Text>
            ) : null}
            <Paper className="virentia-inspector__modal-section" withBorder>
              <Group align="flex-start" justify="space-between" gap="xs" wrap="nowrap">
                <Box>
                  <Text fw={650} size="xs">
                    Breakpoints
                  </Text>
                  <Text size="xs" c="dimmed">
                    The chain will stop after the selected units
                  </Text>
                </Box>
                <Button color="green" size="xs" variant="light" onClick={startBreakpointSelection}>
                  Select
                </Button>
              </Group>
              {breakpointSummary}
            </Paper>
            <Group justify="space-between" mt={4}>
              <Button color="gray" size="xs" variant="subtle" onClick={requestCloseTriggerFlow}>
                Cancel
              </Button>
              <Button color="green" size="xs" onClick={acceptPayload}>
                Continue
              </Button>
            </Group>
          </Stack>
        ) : null}

        {triggerStage === "confirm" ? (
          <Stack gap="xs">
            <Box>
              <Text size="xs" c="dimmed">
                Payload
              </Text>
              <Text className="virentia-inspector__payload">
                {payloadText.trim() || "undefined"}
              </Text>
            </Box>
            <Paper className="virentia-inspector__modal-section" withBorder>
              <Group align="flex-start" justify="space-between" gap="xs" wrap="nowrap">
                <Box>
                  <Text fw={650} size="xs">
                    Breakpoints
                  </Text>
                  <Text size="xs" c="dimmed">
                    You can change them before triggering
                  </Text>
                </Box>
                <Button color="green" size="xs" variant="light" onClick={startBreakpointSelection}>
                  Select
                </Button>
              </Group>
              {breakpointSummary}
            </Paper>
            {triggerError ? (
              <Text size="xs" c="red">
                {triggerError}
              </Text>
            ) : null}
            <Group justify="space-between" mt={4}>
              <Button color="gray" size="xs" variant="subtle" onClick={requestCloseTriggerFlow}>
                Cancel
              </Button>
              <Button color="green" size="xs" onClick={() => void triggerSelectedNode()}>
                Trigger
              </Button>
            </Group>
          </Stack>
        ) : null}

        {triggerStage === "result" ? (
          <Stack gap="xs">
            <Badge color={triggerResult?.ok ? "green" : "red"} size="xs" variant="light">
              {triggerResult?.ok
                ? "Triggered successfully"
                : (triggerResult?.error?.preview ?? "Error")}
            </Badge>
            <Group justify="end">
              <Button color="green" size="xs" onClick={requestCloseTriggerFlow}>
                Close
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </Box>
  );
}

interface FlowGraphOptions {
  breakpointIds: ReadonlySet<string>;
  breakpointSelectionActive: boolean;
  eligibleNodeIds: ReadonlySet<string>;
}

function useFlowGraph(
  snapshot: DevtoolsSnapshot,
  selectedFlow: ReactiveSelection | null,
  options: FlowGraphOptions,
) {
  const selectedNodeIds = useMemo(() => new Set(selectedFlow?.nodeIds ?? []), [selectedFlow]);
  const selectedEdgeIds = useMemo(() => new Set(selectedFlow?.edgeIds ?? []), [selectedFlow]);

  return useMemo(() => {
    const layout = new Map(createFlowLayout(snapshot).map((item) => [item.id, item]));
    const nodes: UnitFlowNodeModel[] = snapshot.nodes.map((node) => {
      const position = layout.get(node.id) ?? { x: 0, y: 0 };
      const active = selectedNodeIds.has(node.id);
      const eligible = options.eligibleNodeIds.has(node.id);
      const breakpoint = options.breakpointIds.has(node.id);

      return {
        id: node.id,
        className: [
          options.breakpointSelectionActive && !eligible ? "is-dimmed" : "",
          breakpoint ? "is-breakpoint" : "",
        ]
          .filter(Boolean)
          .join(" "),
        position: {
          x: position.x,
          y: position.y,
        },
        type: "unit",
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selected: active,
        data: {
          node,
        },
      };
    });
    const edges: Edge[] = snapshot.edges.map((edge) => {
      const active = selectedEdgeIds.has(edge.id);
      const owner = edge.kind === "owner";
      const dimmed =
        options.breakpointSelectionActive &&
        (!options.eligibleNodeIds.has(edge.source) || !options.eligibleNodeIds.has(edge.target));

      return {
        id: edge.id,
        source: edge.source,
        sourceHandle: "source",
        target: edge.target,
        targetHandle: "target",
        animated: active,
        type: "smoothstep",
        style: {
          opacity: dimmed ? 0.22 : 1,
          stroke: active ? "var(--virentia-accent)" : owner ? "#424242" : "#696969",
          strokeDasharray: owner ? "6 4" : undefined,
          strokeWidth: active ? 3 : owner ? 1.1 : 1.4,
        },
      };
    });

    return { nodes, edges };
  }, [options, selectedEdgeIds, selectedNodeIds, snapshot]);
}

function hideIsolatedNodes(snapshot: DevtoolsSnapshot): DevtoolsSnapshot {
  const connectedNodeIds = new Set<string>();

  for (const edge of snapshot.edges) {
    if (edge.kind === "reactive") {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    }
  }

  for (const node of snapshot.nodes) {
    if (node.parentId && connectedNodeIds.has(node.id)) {
      connectedNodeIds.add(node.parentId);
    }
  }

  return {
    ...snapshot,
    breakpoints: snapshot.breakpoints.filter((id) => connectedNodeIds.has(id)),
    edges: snapshot.edges.filter(
      (edge) => connectedNodeIds.has(edge.source) && connectedNodeIds.has(edge.target),
    ),
    nodes: snapshot.nodes.filter((node) => connectedNodeIds.has(node.id)),
  };
}
