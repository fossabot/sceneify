import { SourceItemType } from "./types";
import { OBS } from "./OBS";
import { SceneItem, SceneItemTransform } from "./SceneItem";
import { DeepPartial } from "./types";
import { wait } from "./utils";
import { SourceFilters, Source } from "./Source";
import { Input } from ".";

/**
 * Describes how a scene item should be created, including its base source and transform
 */
export type SceneItemSchema<T extends Source = Source> = {
  source: T;
} & DeepPartial<SceneItemTransform>;

/**
 * Describes a scene's map of scene items with {@link SceneItemSchema ItemSchemaInputs}
 */
export type SceneItemSchemas<Items extends Record<string, Source>> = {
  [K in keyof Items]: SceneItemSchema<Items[K]>;
};

interface LinkOptions {
  // requireItemOrder: boolean;
  // requireFilterOrder: boolean;
  setProperties: boolean;
  setSourceSettings: boolean;
}

export interface SceneArgs<
  Items extends Record<string, Source>,
  Filters extends SourceFilters
> {
  name: string;
  items: SceneItemSchemas<Items>;
  filters?: Filters;
}

export class Scene<
  Items extends Record<string, Source> = {},
  Filters extends SourceFilters = {}
> extends Source<Filters> {
  items: SceneItem[] = [];

  private itemsSchema: SceneItemSchemas<Items>;

  /**
   * MAIN METHODS
   *
   * Methods that provide functionality specific to sceneify.
   */

  /**  */
  constructor(args: SceneArgs<Items, Filters>) {
    super({ ...args, kind: "scene" });

    this.itemsSchema = args.items;
  }

  /**
   * Creates a scene in OBS and populates it with items as defined by the scene's items schema.
   */
  async create(obs: OBS): Promise<this> {
    // If scene exists, it is initialized. Thus, no need to throw an error if it's already initialized
    if (this.exists) return this;

    await this.initialize(obs);

    if (!this.exists) {
      await obs.call("CreateScene", {
        sceneName: this.name,
      });
      await this.pushRefs();
    }

    await wait(50);

    this._exists = true;

    obs.scenes.set(this.name, this);

    for (const ref in this.itemsSchema) {
      await this.createItem(ref, this.itemsSchema[ref]);
    }

    await this.setPrivateSettings({
      SIMPLE_OBS_LINKED: false,
    });

    return this;
  }

  /**
   * Links to an existing scene in OBS, verifying that all sources as defined by the scene's items schema exist.
   * Will mark itself as existing if a matching scene is found, but will still throw if the items schema is not matched.
   */
  async link(obs: OBS, options?: Partial<LinkOptions>) {
    this.obs = obs;

    if (this.initalized)
      throw new Error(
        `Failed to link scene ${this.name}: Scene is already initialized`
      );

    // First, check if the scene exists by fetching its scene item list. Fail if scene isn't found
    const { sceneItems } = await obs
      .call("GetSceneItemList", {
        sceneName: this.name,
      })
      .catch(() => {
        throw new Error(
          `Failed to link scene ${this.name}: Scene does not exist`
        );
      });

    this._exists = true;

    let multipleItemSources = [],
      noItemSources = [];

    // Iterate through the required items a first time to determine if the scene can be linked
    for (let ref in this.itemsSchema) {
      let itemSchema = this.itemsSchema[ref];

      // Get all items in scene with current item's source type
      const sourceItems = sceneItems.filter(
        (i) => i.sourceName === itemSchema.source.name
      );

      if (sourceItems.length === 0) noItemSources.push(itemSchema.source);
      else if (sourceItems.length > 1)
        multipleItemSources.push(itemSchema.source);
    }

    // If multiple or none of any of the sources exist as items in the scene, fail
    if (multipleItemSources.length !== 0 || noItemSources.length !== 0)
      throw new Error(
        `Failed to link scene ${this.name}:${
          multipleItemSources.length !== 0
            ? ` Scene contains multiple items of source${
                multipleItemSources.length > 1 ? "s" : ""
              } ${multipleItemSources.map((s) => `'${s.name}'`).join(", ")}.`
            : ``
        }${
          noItemSources.length !== 0
            ? ` Scene contains no items of source${
                noItemSources.length > 1 ? "s" : ""
              } ${noItemSources.map((s) => `'${s.name}'`).join(", ")}.`
            : ``
        }`
      );

    // Iterate through a second time to actually link the scene items.
    await Promise.all(
      Object.entries(this.itemsSchema).map(
        async ([ref, { source, ...transform }]: [string, SceneItemSchema]) => {
          const schemaItem = sceneItems.find(
            (i) => i.sourceName === source.name
          )!;

          // Create a SceneItem for the source, marking the source as inialized and such in the process
          const item: SceneItem<any> = source.linkItem(
            this,
            schemaItem.sceneItemId,
            ref
          );

          this.items.push(item);

          await item.fetchProperties();

          let optionRequests: Promise<any>[] = [];
          if (options?.setProperties)
            optionRequests.push(item.setTransform(transform));
          if (options?.setSourceSettings && source instanceof Input)
            optionRequests.push(source.setSettings(source.settings));

          return Promise.all(optionRequests);
        }
      )
    );

    await this.setPrivateSettings({
      SIMPLE_OBS_LINKED: true,
    } as any);

    // TODO: Ordering options
  }

  async createItem<T extends Source>(
    ref: string,
    itemSchema: SceneItemSchema<T>
  ) {
    const { source, ...transform } = itemSchema;

    // Check if the source is initialized to ensure that `source.exists` is accurate
    await source.initialize(this.obs);

    // Source is initialized, try to create an item of it, letting the source be
    // responsible for creating itself if required
    const item = await source.createSceneItem(ref, this);

    if (Object.keys(transform).length !== 0)
      await item.setTransform(transform as SceneItemTransform);

    // Get the item's properties and assign them in case some properties are dependent
    // on things like source settings (eg. Image source, where width and height is dependent
    // on the size of the image)
    await item.fetchProperties();

    this.items.push(item);

    return item;
  }

  item<R extends keyof Items>(ref: R): SourceItemType<Items[R]>;
  item(ref: string): SceneItem | undefined;

  /**
   * Gets a scene item from the scene by its ref.
   */
  item(ref: string) {
    return this.items.find((i) => i.ref === ref);
  }

  protected async createFirstSceneItem(scene: Scene): Promise<number> {
    await this.create(scene.obs);

    const { sceneItemId } = await this.obs.call("CreateSceneItem", {
      sceneName: scene.name,
      sourceName: this.name,
    });

    this.obs.scenes.set(this.name, this);

    return sceneItemId;
  }

  protected async fetchExists() {
    // Check if source exists
    try {
      await this.obs.call("GetSourcePrivateSettings", {
        sourceName: this.name,
      });
    } catch {
      return false;
    }

    // Does exist, check if it's an input
    const input = await this.obs
      .call("GetInputSettings", {
        inputName: this.name,
      })
      .then((input) => input)
      .catch(() => undefined);

    if (input)
      throw new Error(
        `Failed to initiailze scene ${this.name}: Input of kind ${input.inputKind} with this name already exists.`
      );

    return true;
  }

  /**
   * @param preview Whether to make the scene the current preview scene
   */
  async makeCurrentScene(preview?: boolean) {
    await this.obs.call(
      preview ? "SetCurrentPreviewScene" : "SetCurrentProgramScene",
      { sceneName: this.name }
    );
  }
}
