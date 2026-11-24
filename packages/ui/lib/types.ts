import type { EventCallable, Scope, StoreWritable } from "@virentia/core";
import type { AnyModel, InstanceOf } from "@virentia/core/models";
import type { Context } from "./native-runtime";

/** A native component descriptor or a pure, model-free view fragment. */
export type Component<P = {}> = (props: P, self: any) => Child;

/** Lexically bound, typed context; there is no global UI self. */
export type ComponentSelf<M extends AnyModel = AnyModel> = {
  readonly id: string;
  readonly scope: Scope;
  readonly model: InstanceOf<M>;
  readonly instances: readonly InstanceOf<M>[];
  elementId(name: string): string;
  context<T>(target: Context<T>): () => T;
} & Pick<InstanceOf<M>, Extract<keyof InstanceOf<M>, "mounted" | "unmounted">>;

/** A pure structural view; its direct reactive reads may cause it to run again. */
export type View = () => Child;

/** A value that the renderer reads inside its own reactive subscription. */
export interface Readable<T> {
  readonly value: T;
  readonly node: unknown;
}

/** Plain values, store units and explicit JavaScript accessors are all valid bindings. */
export type Binding<T> = T | Readable<T> | (() => T);

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
  | Readable<Child>
  | View;

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

/** Only the call signature and Core node are needed by the DOM dispatcher. */
export type DOMEventUnit<T extends EventTarget, E extends Event = Event> =
  (((payload: NativeEvent<T, E>) => unknown) & Pick<EventCallable<any>, "node">)
  | EventCallable<void>;

/** A transient, writable store belonging to a model instance. */
export type RefUnit<T extends Element = Element> = StoreWritable<T | null>;

export type Ref<T extends Element> = {
  value: T | null;
  readonly node: unknown;
  readonly writable: true;
};

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
  [K in keyof EventNames as K | `${K}Capture`]?: DOMEventUnit<T, EventFor<EventNames[K]>> | null;
} & {
  [K in keyof GlobalEventHandlersEventMap as `on:${K}`]?: DOMEventUnit<T, GlobalEventHandlersEventMap[K]> | null;
};

type StyleProperty = {
  [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? K : never;
}[keyof CSSStyleDeclaration] &
  string;

type KebabCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `-${Lowercase<Head>}`}${KebabCase<Tail>}`
  : S;

export type CSSProperties = {
  [K in StyleProperty | KebabCase<StyleProperty> | `--${string}`]?: Binding<string | number | null>;
};

export type ClassList = Record<string, Binding<boolean | null | undefined>>;

type ScalarProperties<T> = {
  [K in keyof T as K extends string
    ? T[K] extends string | number | boolean | null
      ? K
      : never
    : never]?: Binding<T[K] | null>;
};

export type DOMAttributes<T extends Element> = EventHandlers<T> & {
  children?: Child;
  key?: string | number | symbol;
  ref?: Ref<T> | null;
  class?: Binding<string | null>;
  className?: Binding<string | null>;
  classList?: Binding<ClassList>;
  style?: Binding<string | CSSProperties | null>;
  role?: Binding<string>;
} & {
  [K in `data-${string}` | `aria-${string}`]?: Binding<string | number | boolean | null>;
};

export type HTMLAttributes<T extends HTMLElement> = Omit<
  ScalarProperties<T>,
  keyof DOMAttributes<T> | "children"
> &
  DOMAttributes<T> & {
    for?: Binding<string>;
    spellcheck?: Binding<boolean | "true" | "false">;
    contenteditable?: Binding<boolean | "true" | "false" | "plaintext-only">;
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
    [K in keyof T as SVGValue<T[K]> extends never ? never : K]?: Binding<SVGValue<T[K]> | null>;
  } & {
    [K in SVGPresentationAttribute | KebabCase<SVGPresentationAttribute>]?: Binding<
      string | number | null
    >;
  } & {
    d?: Binding<string>;
    points?: Binding<string>;
    xmlns?: Binding<string>;
    "xmlns:xlink"?: Binding<string>;
    "xlink:href"?: Binding<string>;
  };

type DOMIntrinsicElements = {
  [K in keyof HTMLElementTagNameMap]: HTMLAttributes<HTMLElementTagNameMap[K]>;
} & {
  [K in Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>]: SVGAttributes<
    SVGElementTagNameMap[K]
  >;
};

export type IntrinsicElements = DOMIntrinsicElements;

export namespace JSX {
  export type Element = ElementDescriptor;
  export type ElementType = keyof IntrinsicElements | Component<any>;
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {
    key?: string | number | symbol;
    /** Local component-model identity; otherwise a fresh model ID is generated. */
    id?: string;
  }
  export type IntrinsicElements = DOMIntrinsicElements;
}
