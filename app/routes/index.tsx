import InfiniteCanvas from "~/app/components/infinite-canvas";

export function meta() {
  return [
    { title: "Infinite Texture Canvas" },
    {
      name: "description",
      content:
        "Infinite pannable canvas rendering 100+ textures via WebGL2 texture arrays and instanced drawing.",
    },
  ];
}

export default function Index() {
  return <InfiniteCanvas textureCount={200} textureSize={1024} />;
}
