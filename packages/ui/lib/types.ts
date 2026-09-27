import type { Event as CoreEvent, Scope } from "@virentia/core";
import type { InstanceApi } from "@virentia/core/models";

export interface ComponentLifecycleEvent<P> {
  readonly id: string;
  readonly model: InstanceApi;
  readonly props: P;
  readonly scope: Scope;
}

/** Per-instance Core event sources, retained with setup when `keep: true`. */
export interface ComponentLifecycle<P> {
  readonly mounted: CoreEvent<ComponentLifecycleEvent<P>>;
  readonly unmounted: CoreEvent<ComponentLifecycleEvent<P>>;
}

/** A component runs once per instance; reactive bindings update its DOM. */
export type Component<P = {}> = (props: P, lifecycle: ComponentLifecycle<P>) => Child;

export interface ElementDescriptor {
  readonly type: string | Component<any> | symbol;
  readonly props: Record<string, unknown>;
}

export type Child =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Node
  | ElementDescriptor
  | readonly Child[]
  | (() => Child);

/** HTML containers supported as opaque hosts for optional React/Vue trees. */
export type ForeignHostTag =
  | Exclude<
      keyof HTMLElementTagNameMap,
      | "area"
      | "base"
      | "body"
      | "br"
      | "col"
      | "embed"
      | "head"
      | "html"
      | "hr"
      | "iframe"
      | "img"
      | "input"
      | "link"
      | "meta"
      | "noscript"
      | "option"
      | "optgroup"
      | "param"
      | "script"
      | "select"
      | "source"
      | "style"
      | "template"
      | "textarea"
      | "title"
      | "track"
      | "wbr"
    >
  | `${string}-${string}`;

export type ComponentProps<T extends Component<any> | keyof IntrinsicElements> =
  T extends Component<infer P>
    ? P
    : T extends keyof IntrinsicElements
      ? IntrinsicElements[T]
      : never;

export type NativeEvent<T extends EventTarget, E extends Event = Event> = Omit<
  E,
  "currentTarget"
> & {
  readonly currentTarget: T;
};

export type EventHandler<T extends EventTarget, E extends Event = Event> = (
  event: NativeEvent<T, E>,
) => void;

export type Ref<T extends Element> = ((element: T) => void | (() => void)) | { current: T | null };

type EventNames = {
  onAbort: "abort";
  onAnimationCancel: "animationcancel";
  onAnimationEnd: "animationend";
  onAnimationIteration: "animationiteration";
  onAnimationStart: "animationstart";
  onAuxClick: "auxclick";
  onBeforeInput: "beforeinput";
  onBlur: "blur";
  onCancel: "cancel";
  onCanPlay: "canplay";
  onCanPlayThrough: "canplaythrough";
  onChange: "change";
  onClick: "click";
  onClose: "close";
  onCompositionEnd: "compositionend";
  onCompositionStart: "compositionstart";
  onCompositionUpdate: "compositionupdate";
  onContextMenu: "contextmenu";
  onCopy: "copy";
  onCut: "cut";
  onDoubleClick: "dblclick";
  onDrag: "drag";
  onDragEnd: "dragend";
  onDragEnter: "dragenter";
  onDragLeave: "dragleave";
  onDragOver: "dragover";
  onDragStart: "dragstart";
  onDrop: "drop";
  onDurationChange: "durationchange";
  onEmptied: "emptied";
  onEnded: "ended";
  onError: "error";
  onFocus: "focus";
  onFocusIn: "focusin";
  onFocusOut: "focusout";
  onGotPointerCapture: "gotpointercapture";
  onInput: "input";
  onInvalid: "invalid";
  onKeyDown: "keydown";
  onKeyPress: "keypress";
  onKeyUp: "keyup";
  onLoad: "load";
  onLoadedData: "loadeddata";
  onLoadedMetadata: "loadedmetadata";
  onLoadStart: "loadstart";
  onLostPointerCapture: "lostpointercapture";
  onMouseDown: "mousedown";
  onMouseEnter: "mouseenter";
  onMouseLeave: "mouseleave";
  onMouseMove: "mousemove";
  onMouseOut: "mouseout";
  onMouseOver: "mouseover";
  onMouseUp: "mouseup";
  onPaste: "paste";
  onPause: "pause";
  onPlay: "play";
  onPlaying: "playing";
  onPointerCancel: "pointercancel";
  onPointerDown: "pointerdown";
  onPointerEnter: "pointerenter";
  onPointerLeave: "pointerleave";
  onPointerMove: "pointermove";
  onPointerOut: "pointerout";
  onPointerOver: "pointerover";
  onPointerUp: "pointerup";
  onProgress: "progress";
  onRateChange: "ratechange";
  onReset: "reset";
  onResize: "resize";
  onScroll: "scroll";
  onScrollEnd: "scrollend";
  onSeeked: "seeked";
  onSeeking: "seeking";
  onSelect: "select";
  onSlotChange: "slotchange";
  onStalled: "stalled";
  onSubmit: "submit";
  onSuspend: "suspend";
  onTimeUpdate: "timeupdate";
  onToggle: "toggle";
  onTouchCancel: "touchcancel";
  onTouchEnd: "touchend";
  onTouchMove: "touchmove";
  onTouchStart: "touchstart";
  onTransitionCancel: "transitioncancel";
  onTransitionEnd: "transitionend";
  onTransitionRun: "transitionrun";
  onTransitionStart: "transitionstart";
  onVolumeChange: "volumechange";
  onWaiting: "waiting";
  onWheel: "wheel";
};

type EventFor<K extends string> = K extends keyof GlobalEventHandlersEventMap
  ? GlobalEventHandlersEventMap[K]
  : Event;

export type EventHandlers<T extends EventTarget> = {
  [K in keyof EventNames as K | `${K}Capture`]?: EventHandler<T, EventFor<EventNames[K]>> | null;
} & {
  [K in keyof GlobalEventHandlersEventMap as `on:${K}`]?: EventHandler<
    T,
    GlobalEventHandlersEventMap[K]
  > | null;
};

type StyleProperty = {
  [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? K : never;
}[keyof CSSStyleDeclaration] &
  string;

type KebabCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `-${Lowercase<Head>}`}${KebabCase<Tail>}`
  : S;

export type CSSProperties = {
  [K in StyleProperty | KebabCase<StyleProperty> | `--${string}`]?: string | number | null;
};

export type ClassList = Record<string, boolean | null | undefined>;

type ScalarProperties<T> = {
  [K in keyof T as K extends string
    ? T[K] extends string | number | boolean | null
      ? K
      : never
    : never]?: T[K] | null;
};

export type DOMAttributes<T extends Element> = EventHandlers<T> & {
  children?: Child;
  key?: string | number | symbol;
  ref?: Ref<T> | null;
  class?: string | null;
  className?: string | null;
  classList?: ClassList;
  style?: string | CSSProperties | null;
  role?: string;
} & {
  [K in `data-${string}` | `aria-${string}`]?: string | number | boolean | null;
};

export type HTMLAttributes<T extends HTMLElement> = Omit<
  ScalarProperties<T>,
  keyof DOMAttributes<T> | "children"
> &
  DOMAttributes<T> & {
    for?: string;
    spellcheck?: boolean | "true" | "false";
    contenteditable?: boolean | "true" | "false" | "plaintext-only";
  };

type SVGPresentationAttribute =
  | "fill"
  | "fillOpacity"
  | "fillRule"
  | "stroke"
  | "strokeWidth"
  | "strokeOpacity"
  | "strokeLinecap"
  | "strokeLinejoin"
  | "strokeMiterlimit"
  | "strokeDasharray"
  | "strokeDashoffset"
  | "clipPath"
  | "clipRule"
  | "color"
  | "colorInterpolation"
  | "cursor"
  | "display"
  | "filter"
  | "fontFamily"
  | "fontSize"
  | "fontWeight"
  | "letterSpacing"
  | "markerEnd"
  | "markerMid"
  | "markerStart"
  | "mask"
  | "opacity"
  | "overflow"
  | "paintOrder"
  | "pointerEvents"
  | "shapeRendering"
  | "stopColor"
  | "stopOpacity"
  | "textAnchor"
  | "textDecoration"
  | "transform"
  | "transformOrigin"
  | "vectorEffect"
  | "visibility";

type SVGValue<T> = T extends SVGAnimatedString | SVGAnimatedEnumeration
  ? string
  : T extends
        | SVGAnimatedNumber
        | SVGAnimatedInteger
        | SVGAnimatedLength
        | SVGAnimatedNumberList
        | SVGAnimatedLengthList
    ? string | number
    : T extends SVGAnimatedBoolean
      ? boolean | "true" | "false"
      : T extends SVGAnimatedRect | SVGAnimatedPreserveAspectRatio | SVGAnimatedTransformList
        ? string
        : never;

export type SVGAttributes<T extends SVGElement> = Omit<
  ScalarProperties<T>,
  keyof DOMAttributes<T> | "children"
> &
  DOMAttributes<T> & {
    [K in keyof T as SVGValue<T[K]> extends never ? never : K]?: SVGValue<T[K]> | null;
  } & {
    [K in SVGPresentationAttribute | KebabCase<SVGPresentationAttribute>]?: string | number | null;
  } & {
    d?: string;
    points?: string;
    xmlns?: string;
    "xmlns:xlink"?: string;
    "xlink:href"?: string;
  };

export type IntrinsicElements = {
  [K in keyof HTMLElementTagNameMap]: HTMLAttributes<HTMLElementTagNameMap[K]>;
} & {
  [K in Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>]: SVGAttributes<
    SVGElementTagNameMap[K]
  >;
};

export namespace JSX {
  export type Element = ElementDescriptor;
  export type ElementType = keyof IntrinsicElements | Component<any>;
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {
    key?: string | number | symbol;
    /** Optional component-model identity; generated from the tree when omitted. */
    id?: string;
  }
  export type IntrinsicElements = import("./types").IntrinsicElements;
}
