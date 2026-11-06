// Freeing GPU memory. Removing an object from the scene doesn't free its
// geometry, materials or textures: three.js keeps them on the GPU until
// they're disposed. Over a long session (thousands of bolts, sparks and
// fragments, and every level change) that adds up, and a low-memory machine
// can lose the WebGL context or crash the tab.

import * as THREE from 'three';

/**
 * Dispose everything under `root` (geometries, materials, and textures unless
 * they're in `keep` or `keepTextures` is false), and detach it.
 */
export function disposeTree(root: THREE.Object3D, keep: Set<THREE.Texture> = new Set(), keepTextures = false, keepGeometry: Set<THREE.BufferGeometry> = new Set()) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !keepGeometry.has(m.geometry)) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (!keepTextures) {
        for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
          if (v instanceof THREE.Texture && !keep.has(v)) v.dispose();
        }
      }
      mat.dispose();
    }
  });
  root.removeFromParent();
}
