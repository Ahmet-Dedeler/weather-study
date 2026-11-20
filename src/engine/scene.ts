interface Mesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface SceneInputs {
  center: [number, number];
  depthHalfExtent: number;
  gridSize: number;
  land: Mesh;
  structures: Mesh;
  depth: Float32Array;
  heights: Float32Array;
  shoreline: Float32Array;
  noise: Uint8Array;
  detail: ImageBitmap[];
  models: (Mesh & {
    placements: Float32Array;
    wind: boolean;
    batches: { texture: string | null; indexCount: number }[];
  })[];
  textures: Map<string, ImageBitmap>;
}
