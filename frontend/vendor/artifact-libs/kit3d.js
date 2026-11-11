// =====================================================================
// Набор для 3D-моделей (этап 15б). Работает внутри песочницы артефакта
// после three.min.js и three-addons.js (r147).
//
// Даёт коду модели простые функции (размеры в миллиметрах, детали создаются
// по центру — как в OpenSCAD с center=true):
//   box(ш, в, г), cylinder(r, h), sphere(r), cone(r, h), torus(R, r)
//   move(o, x, y, z), rotate(o, ax, ay, az) — в градусах, scale(o, k)
//   union(a, b, …), subtract(a, b, …), intersect(a, b, …) — булевы операции
//   add(o, …) — добавить в модель; color(o, "#ff8800")
// После кода модель ставится на сетку, камера наводится сама, видны размеры.
// Кнопки: STL (3D-печать, ось Z вверх), OBJ и GLB (Blender), авто-вращение, каркас.
//
// Булевы операции — компактная версия алгоритма CSG на BSP-деревьях
// (идея и структура — csg.js Эвана Уоллеса, MIT).
// =====================================================================

/* global THREE */
(function () {
  const send = (d) => (window.__artifactSend ? window.__artifactSend(d) : null);

  // Набор подключается в <head>, где <body> ещё нет: элементы страницы добавляем, когда он появится
  const onBody = (fn) => (document.body ? fn() : document.addEventListener("DOMContentLoaded", fn));

  // ---------- сцена ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  onBody(() => {
    document.body.style.cssText = "margin:0;overflow:hidden;background:#0d1117;font:13px system-ui,sans-serif;color:#d6e2ee";
    document.body.appendChild(renderer.domElement);
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100000);
  camera.position.set(150, 120, 150);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x20262e, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const back = new THREE.DirectionalLight(0x88aaff, 0.3);
  back.position.set(-1, 0.5, -1);
  scene.add(back);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let grid = null;
  const model = new THREE.Group();
  scene.add(model);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  // ---------- детали ----------
  const DEFAULT_COLOR = 0x6fb7ff;
  const material = (c) => new THREE.MeshStandardMaterial({ color: c ?? DEFAULT_COLOR, metalness: 0.1, roughness: 0.55 });
  const mesh = (geometry, c) => new THREE.Mesh(geometry, material(c));
  const SEG = 64;

  const api = {
    THREE, scene, model,
    box: (w, h, d, c) => mesh(new THREE.BoxGeometry(w, h, d), c),
    cylinder: (r, h, c, segments = SEG) => mesh(new THREE.CylinderGeometry(r, r, h, segments), c),
    cone: (r, h, c, segments = SEG) => mesh(new THREE.ConeGeometry(r, h, segments), c),
    sphere: (r, c) => mesh(new THREE.SphereGeometry(r, SEG, SEG / 2), c),
    torus: (R, r, c) => mesh(new THREE.TorusGeometry(R, r, 24, SEG), c),
    move(o, x = 0, y = 0, z = 0) { o.position.x += x; o.position.y += y; o.position.z += z; return o; },
    rotate(o, ax = 0, ay = 0, az = 0) {
      const d = Math.PI / 180;
      o.rotation.x += ax * d; o.rotation.y += ay * d; o.rotation.z += az * d;
      return o;
    },
    scale(o, k) { o.scale.multiplyScalar(k); return o; },
    color(o, c) { o.traverse((m) => m.isMesh && (m.material = material(c))); return o; },
    add(...objects) { for (const o of objects) if (o) model.add(o); return objects[0]; },
    union: (...m) => csgReduce(m, "union"),
    subtract: (...m) => csgReduce(m, "subtract"),
    intersect: (...m) => csgReduce(m, "intersect"),
  };
  Object.assign(window, api);

  // ---------- CSG: булевы операции над сетками ----------
  const EPS = 1e-5;
  class Plane {
    constructor(normal, w) { this.normal = normal; this.w = w; }
    static from(a, b, c) {
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      return new Plane(n, n.dot(a));
    }
    clone() { return new Plane(this.normal.clone(), this.w); }
    flip() { this.normal.negate(); this.w = -this.w; }
    // Делит многоугольник плоскостью: в списки «лежит в плоскости спереди/сзади», «спереди», «сзади»
    split(poly, coFront, coBack, front, back) {
      const types = [];
      let polyType = 0;
      for (const v of poly.vertices) {
        const t = this.normal.dot(v) - this.w;
        const type = t < -EPS ? 2 : t > EPS ? 1 : 0;
        polyType |= type;
        types.push(type);
      }
      if (polyType === 0) (this.normal.dot(poly.plane.normal) > 0 ? coFront : coBack).push(poly);
      else if (polyType === 1) front.push(poly);
      else if (polyType === 2) back.push(poly);
      else {
        const f = [], b = [];
        const n = poly.vertices.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ti = types[i], tj = types[j], vi = poly.vertices[i], vj = poly.vertices[j];
          if (ti !== 2) f.push(vi);
          if (ti !== 1) b.push(ti !== 2 ? vi.clone() : vi);
          if ((ti | tj) === 3) {
            const t = (this.w - this.normal.dot(vi)) / this.normal.dot(new THREE.Vector3().subVectors(vj, vi));
            const v = vi.clone().lerp(vj, t);
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) front.push(new Polygon(f, poly.plane));
        if (b.length >= 3) back.push(new Polygon(b, poly.plane));
      }
    }
  }
  class Polygon {
    constructor(vertices, plane) {
      this.vertices = vertices;
      this.plane = plane ? plane.clone() : Plane.from(vertices[0], vertices[1], vertices[2]);
    }
    clone() { return new Polygon(this.vertices.map((v) => v.clone()), this.plane); }
    flip() { this.vertices.reverse(); this.plane.flip(); }
  }
  class Node {
    constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
    invert() {
      for (const p of this.polys) p.flip();
      this.plane?.flip(); // у пустого узла (деталь целиком вырезана) плоскости нет
      this.front?.invert();
      this.back?.invert();
      [this.front, this.back] = [this.back, this.front];
    }
    clipPolys(polys) {
      if (!this.plane) return polys.slice();
      let front = [], back = [];
      for (const p of polys) this.plane.split(p, front, back, front, back);
      if (this.front) front = this.front.clipPolys(front);
      back = this.back ? this.back.clipPolys(back) : [];
      return front.concat(back);
    }
    clipTo(bsp) {
      this.polys = bsp.clipPolys(this.polys);
      this.front?.clipTo(bsp);
      this.back?.clipTo(bsp);
    }
    all() {
      let result = this.polys.slice();
      if (this.front) result = result.concat(this.front.all());
      if (this.back) result = result.concat(this.back.all());
      return result;
    }
    build(polys) {
      if (!polys.length) return;
      if (!this.plane) this.plane = polys[0].plane.clone();
      const front = [], back = [];
      for (const p of polys) this.plane.split(p, this.polys, this.polys, front, back);
      if (front.length) (this.front ??= new Node()).build(front);
      if (back.length) (this.back ??= new Node()).build(back);
    }
  }

  /** Сетка (с учётом её положения/поворота) → многоугольники в мировых координатах. */
  function toPolys(object) {
    const polys = [];
    object.updateMatrixWorld(true);
    object.traverse((m) => {
      if (!m.isMesh) return;
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        const vs = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, i + k).applyMatrix4(m.matrixWorld));
        if (vs[0].distanceTo(vs[1]) < EPS || vs[1].distanceTo(vs[2]) < EPS || vs[0].distanceTo(vs[2]) < EPS) continue;
        polys.push(new Polygon(vs));
      }
    });
    return polys;
  }

  function fromPolys(polys, mat) {
    const positions = [], normals = [];
    for (const p of polys) {
      for (let i = 1; i + 1 < p.vertices.length; i++) { // многоугольник → веер треугольников
        for (const v of [p.vertices[0], p.vertices[i], p.vertices[i + 1]]) {
          positions.push(v.x, v.y, v.z);
          normals.push(p.plane.normal.x, p.plane.normal.y, p.plane.normal.z);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    return new THREE.Mesh(g, mat);
  }

  function csg(a, b, op) {
    const A = new Node(toPolys(a)), B = new Node(toPolys(b));
    if (op === "union") {
      A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.all());
      return A.all();
    }
    if (op === "subtract") {
      A.invert(); A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.all()); A.invert();
      return A.all();
    }
    A.invert(); B.clipTo(A); B.invert(); A.clipTo(B); B.clipTo(A); A.build(B.all()); A.invert(); // intersect
    return A.all();
  }

  function firstMaterial(o) {
    let found = null;
    o.traverse((m) => { if (!found && m.isMesh) found = m.material; });
    return found || material();
  }

  function csgReduce(objects, op) {
    const list = objects.flat().filter(Boolean);
    if (!list.length) throw new Error(`${op}: нет деталей`);
    let result = list[0];
    for (const other of list.slice(1)) result = fromPolys(csg(result, other, op), firstMaterial(list[0]));
    return result;
  }

  // ---------- показ: на сетку, камера, размеры ----------
  const info = document.createElement("div");
  info.style.cssText = "position:fixed;left:10px;bottom:10px;padding:6px 10px;background:rgba(0,0,0,.55);border-radius:6px;font-variant-numeric:tabular-nums";
  info.id = "kit-info";
  onBody(() => document.body.appendChild(info));

  let triangles = 0;

  function fit() {
    const boxB = new THREE.Box3().setFromObject(model);
    if (boxB.isEmpty()) return null;
    const size = boxB.getSize(new THREE.Vector3());
    const center = boxB.getCenter(new THREE.Vector3());
    // Ставим модель на «стол»: центр по X/Z в нуле, низ на Y = 0
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= boxB.min.y;
    const radius = Math.max(size.x, size.y, size.z) || 1;
    if (grid) scene.remove(grid);
    const step = Math.pow(10, Math.floor(Math.log10(radius))) || 1;
    grid = new THREE.GridHelper(Math.ceil((radius * 3) / step) * step, Math.ceil((radius * 3) / step), 0x2c4a66, 0x1c2c3c);
    scene.add(grid);
    camera.position.set(radius * 1.4, radius * 1.1, radius * 1.6);
    camera.near = radius / 200;
    camera.far = radius * 200;
    camera.updateProjectionMatrix();
    controls.target.set(0, size.y / 2, 0);
    controls.update();
    triangles = 0;
    model.traverse((m) => {
      if (m.isMesh) triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    });
    const f = (v) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");
    info.textContent = `${f(size.x)} × ${f(size.z)} × ${f(size.y)} мм (Ш × Г × В) · треугольников: ${triangles.toLocaleString("ru-RU")}`;
    return { size: [size.x, size.z, size.y], triangles };
  }

  // ---------- кнопки: экспорт, вращение, каркас ----------
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;top:10px;right:10px;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end";
  onBody(() => document.body.appendChild(bar));
  const button = (label, title, onClick) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.dataset.kit = label;
    b.style.cssText = "background:rgba(20,40,60,.85);color:#d6e2ee;border:1px solid #2f5b80;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit";
    b.onclick = onClick;
    bar.appendChild(b);
    return b;
  };
  const title = () => (document.title || "model").replace(/[\\/:*?"<>|]+/g, "_");

  // STL для печати: в слайсерах «вверх» — ось Z, а у нас Y. Поворачиваем копию на +90° вокруг X.
  function printable() {
    const copy = model.clone(true);
    const holder = new THREE.Group();
    holder.add(copy);
    holder.rotation.x = Math.PI / 2;
    holder.updateMatrixWorld(true);
    return holder;
  }
  button("⤓ STL", "Скачать для 3D-печати (слайсеры: Cura, PrusaSlicer, Bambu Studio)", () => {
    const data = new THREE.STLExporter().parse(printable(), { binary: true });
    send({ type: "download", name: `${title()}.stl`, mime: "model/stl", data: data.buffer || data });
  });
  button("⤓ OBJ", "Скачать для Blender и других редакторов", () => {
    send({ type: "download", name: `${title()}.obj`, mime: "text/plain", data: new THREE.OBJExporter().parse(model) });
  });
  button("⤓ GLB", "Скачать GLB (Blender, просмотрщики, веб)", () => {
    new THREE.GLTFExporter().parse(model, (glb) => send({ type: "download", name: `${title()}.glb`, mime: "model/gltf-binary", data: glb }),
      (e) => send({ type: "error", message: `GLB: ${e.message || e}`, line: 0 }), { binary: true });
  });
  const spin = button("⟳ Вращать", "Авто-вращение", () => {
    controls.autoRotate = !controls.autoRotate;
    spin.style.borderColor = controls.autoRotate ? "#3fd9ff" : "#2f5b80";
  });
  let wire = false;
  button("▦ Каркас", "Показать треугольники", () => {
    wire = !wire;
    model.traverse((m) => { if (m.isMesh) m.material.wireframe = wire; });
  });

  function message(text) {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:30px;color:#ffb648";
    box.textContent = text;
    document.body.appendChild(box);
  }

  let failed = false;
  window.addEventListener("error", () => { failed = true; });

  /** Вызывается после кода модели: показать результат и сообщить размеры. */
  window.__kitFinish = function () {
    if (failed) return; // ошибку уже показала панель с кнопкой «Исправить»
    const result = fit();
    if (!result) {
      message("Модель пустая: добавьте детали в сцену через add(...)");
      send({ type: "error", message: "Модель пустая: ни одна деталь не добавлена через add(...)", line: 0 });
      return;
    }
    send({ type: "model3d", ...result });
  };

  // ---------- просмотр загруженного файла (STL / OBJ / GLB) ----------
  window.__kitWaitFile = function () {
    message("Загружаю модель…");
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (e.source !== window.parent || !d || d.__kitFile !== window.__artifactToken) return;
      document.querySelectorAll("body > div").forEach((el) => { if (el.textContent === "Загружаю модель…") el.remove(); });
      const done = (object) => {
        model.add(object);
        const result = fit();
        send({ type: "model3d", ...result });
      };
      try {
        if (d.format === "stl") {
          // В STL «вверх» — ось Z (так принято у 3D-принтеров), в нашей сцене — Y: поворачиваем на −90° вокруг X
          const geometry = new THREE.STLLoader().parse(d.buffer);
          geometry.computeVertexNormals(); // в STL нормали часто нулевые — тогда деталь выглядит чёрной
          const part = mesh(geometry);
          part.rotation.x = -Math.PI / 2;
          done(part);
        }
        else if (d.format === "obj") {
          const group = new THREE.OBJLoader().parse(new TextDecoder().decode(d.buffer));
          group.traverse((m) => {
            if (!m.isMesh) return;
            m.material = material();
            if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
          });
          done(group);
        } else if (d.format === "glb") {
          new THREE.GLTFLoader().parse(d.buffer, "", (gltf) => done(gltf.scene), (err) => {
            message(`Не удалось прочитать GLB: ${err.message || err}`);
          });
        }
      } catch (err) {
        message(`Не удалось прочитать файл: ${err.message}`);
      }
    });
    send({ type: "need-file" });
  };
})();
