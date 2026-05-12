import { Badge, Box, Group, Text } from "@mantine/core";
import type { DevtoolsTimelineEvent } from "../api";
import type { ReactElement } from "react";

export function TimelineRow(props: { event: DevtoolsTimelineEvent }): ReactElement {
  const color = props.event.breakpoint
    ? "red"
    : props.event.failed
      ? "red"
      : props.event.stopped
        ? "yellow"
        : "green";

  return (
    <Box className="virentia-inspector__timeline-row">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="sm" fw={650} lineClamp={1}>
          {props.event.nodeName}
        </Text>
        <Badge color={color} variant="light">
          {props.event.breakpoint ? "break" : props.event.nodeType}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {props.event.scopeName ?? "No scope"} · {props.event.duration.toFixed(1)} ms
      </Text>
      <Text className="virentia-inspector__payload">payload: {props.event.payload.preview}</Text>
      <Text className="virentia-inspector__payload">result: {props.event.result.preview}</Text>
    </Box>
  );
}
