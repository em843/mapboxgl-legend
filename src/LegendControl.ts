import "./styles/main.scss";
import { IControl } from "mapbox-gl";
import components from "./components";
import Expression from "./expression";
import { createElement } from "./utils";
import type {
  MapboxMap,
  Layer,
  LayerOptions,
  LegendControlOptions,
} from "./types";

export type { LayerOptions, LegendControlOptions };

const defaults: LayerOptions = {
  collapsed: false,
  toggler: false,
  highlight: false,
};

export default class LegendControl implements IControl {
  private _options: {
    layers: Map<string | RegExp, LayerOptions> | undefined;
  } & Omit<LegendControlOptions, "layers">;

  private _container: HTMLElement;

  private _panes: HTMLElement;

  private _minimizer: HTMLElement | undefined;

  private _map!: MapboxMap;

  constructor(options?: LegendControlOptions) {
    const { layers, ...rest } = options || {};
    this._options = { ...defaults, layers: undefined, ...rest };
    if (layers) this.addLayers(layers);

    this._panes = createElement("div", {
      classes: "panes",
      styles: { display: options?.minimized ?? false ? "none" : "block" },
    });

    this._minimizer =
      options?.minimized !== undefined
        ? createElement("button", {
            classes: "minimizer",
            events: {
              click: () => {
                const { display } = this._panes.style;
                this._panes.style.display =
                  display === "none" ? "block" : "none";
              },
            },
          })
        : undefined;

    this._container = createElement("div", {
      classes: ["mapboxgl-ctrl", "maplibregl-ctrl", "mapboxgl-ctrl-legend"],
      content: [this._minimizer, this._panes],
    });

    this.refresh = this.refresh.bind(this);
  }

  onAdd(map: MapboxMap) {
    this._map = map;
    this._map.on("styledata", this.refresh);
    return this._container;
  }

  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map?.off("styledata", this.refresh);
  }

  addLayers(layers: NonNullable<LegendControlOptions["layers"]>) {
    const saveLayerOptions = (
      name: string | RegExp,
      options?: LayerOptions
    ) => {
      const {
        collapsed = this._options.collapsed,
        toggler = this._options.toggler,
        highlight = this._options.highlight,
        onToggle = this._options.onToggle,
        attributes,
      } = options || {};
      this._options.layers?.set(name, {
        collapsed,
        toggler,
        highlight,
        onToggle,
        attributes,
      });
    };

    this._options.layers ??= new Map();
    if (Array.isArray(layers)) layers.forEach((name) => saveLayerOptions(name));
    else
      Object.entries(layers).forEach(([name, options]) => {
        if (typeof options === "boolean") saveLayerOptions(name);
        else if (Array.isArray(options))
          saveLayerOptions(name, { attributes: options });
        else saveLayerOptions(name, options);
      });

    if (this._map?.isStyleLoaded()) this.refresh();
  }

  removeLayers(layerIds: (string | RegExp)[]) {
    layerIds.forEach((id) => {
      this._options.layers?.delete(id);
      const pane = this._panes.querySelector(
        `.mapboxgl-ctrl-legend-pane--${id}`
      );
      if (pane) this._panes.removeChild(pane);
    });
  }

  private _getBlocks(
    key: string | RegExp,
    layer: Layer,
    attribute: string,
    value: any
  ) {
    const [property] = attribute.split("-").slice(-1);
    const component = components[property as keyof typeof components];
    if (!component) return;
    const expressions = Expression.parse(value);
    const options = this._options.layers?.get(key) || this._options;
    return expressions
      .map((expression) => component(expression, layer, this._map, options))
      .filter(Boolean) as HTMLElement[];
  }

  private _toggleButton(layerIds: string[], key: string | RegExp) {
    const { onToggle = this._options.onToggle } =
      this._options.layers?.get(key) || {};
    const visibility =
      this._map?.getLayoutProperty(layerIds[0], "visibility") || "visible";
    const button = createElement("div", {
      classes: ["toggler", `toggler--${visibility}`],
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const visible = visibility === "none" ? "visible" : "none";
      layerIds.forEach((layerId) => {
        this._map?.setLayoutProperty(layerId, "visibility", visible);
        onToggle?.(layerId, visible === "visible");
      });
    });
    return button;
  }

  private _collapseButton(key: string | RegExp, pane: HTMLDetailsElement) {
    let { collapsed = this._options.collapsed } =
      this._options.layers?.get(key) || {};

    // Initialize with current pane state
    const isOpen = pane.hasAttribute("open");
    collapsed = !isOpen;

    const button = createElement("div", {
      classes: ["collapse", `collapse--${collapsed}`],
    });

    // Update button when clicked
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      // Toggle the details element
      pane.toggleAttribute("open");

      // Update button state based on pane's open state
      collapsed = !pane.hasAttribute("open");
      button.classList.remove(`collapse--${!collapsed}`);
      button.classList.add(`collapse--${collapsed}`);
    });

    // Listen to details open/close to keep button state in sync
    pane.addEventListener("toggle", () => {
      collapsed = !pane.hasAttribute("open");
      button.classList.remove(`collapse--${!collapsed}`);
      button.classList.add(`collapse--${collapsed}`);
    });

    return button;
  }

  refresh() {
    const layersIds = this._options.layers
      ? [...this._options.layers.keys()]
      : undefined;
    this._map
      .getStyle()
      ?.layers.filter((layer) => {
        const isValidLayer = "source" in layer && layer.source !== "composite";
        const isActiveLayer =
          !layersIds ||
          [...layersIds].some((name) =>
            typeof name === "string" ? layer.id === name : layer.id.match(name)
          );
        return isValidLayer && isActiveLayer;
      })
      .reverse() // Show in order that are drawn on map (first layers at the bottom, last on top)
      .forEach((layer) => {
        const { id, layout, paint, metadata } = layer as Layer;
        const key = layersIds?.find((name) => id.match(name)) || id;
        const { collapsed, toggler, attributes } =
          this._options.layers?.get(key) || this._options;

        // Construct all required blocks, break if none
        const paneBlocks = Object.entries({ ...layout, ...paint }).reduce(
          (acc, [attribute, value]) => {
            const visible = attributes?.includes(attribute) ?? true;
            if (!visible) return acc;
            const blocks = this._getBlocks(
              key,
              layer as Layer,
              attribute,
              value
            );
            blocks?.forEach((block) => acc.push(block));
            return acc;
          },
          [] as HTMLElement[]
        );
        if (!paneBlocks.length) return;

        // (re)Construct pane and replace (if already exist)
        const selector = `mapboxgl-ctrl-legend-pane--${id}`;
        const prevPane = this._panes.querySelector(`.${selector}`);
        const layerIds = toggler
          ? typeof toggler === "boolean"
            ? [id]
            : toggler
          : undefined;
        const extraClasses = metadata?.extraLegendClasses ?? [];
        const pane = createElement("details", {
          classes: ["mapboxgl-ctrl-legend-pane", selector, ...extraClasses],
          attributes: {
            open: prevPane
              ? prevPane.getAttribute("open") !== null
              : !collapsed,
          },
          content: [
            createElement("summary", {
              content: [
                metadata?.name || id,
                layerIds &&
                  createElement("div", {
                    classes: ["controls-container"],
                    styles: {
                      display: "flex",
                      gap: "4px",
                      alignItems: "center",
                    },
                    content: [
                      createElement("div", {
                        classes: ["collapse-placeholder"],
                      }), // Placeholder for collapse button
                      this._toggleButton(layerIds, key),
                    ],
                  }),
              ],
            }),
            ...paneBlocks,
          ],
        }) as HTMLDetailsElement;

        // Add collapse button after pane is created (so we can pass it as a parameter)
        if (layerIds) {
          const summary = pane.querySelector("summary");
          const controlsContainer = summary?.querySelector(
            ".controls-container"
          );
          const placeholder = controlsContainer?.querySelector(
            ".collapse-placeholder"
          );
          if (controlsContainer && placeholder) {
            controlsContainer.replaceChild(
              this._collapseButton(key, pane),
              placeholder
            );
          }
        }
        if (prevPane) this._panes.replaceChild(pane, prevPane);
        else this._panes.appendChild(pane);
      });
  }
}
