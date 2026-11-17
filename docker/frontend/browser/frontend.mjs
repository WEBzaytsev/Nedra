import { execFileSync, spawnSync } from "node:child_process";
import { get } from "node:http";

const IMAGE =
    process.env.NEDRA_FRONTEND_IMAGE ?? "nedra-frontend:browser-test";

export const startFrontend = async (apiUrl) => {
    const name = `nedra-browser-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    execFileSync("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        `VITE_API_URL=${apiUrl}`,
        "-p",
        "127.0.0.1::3000",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
        IMAGE,
    ]);
    const port = execFileSync("docker", ["port", name, "3000/tcp"])
        .toString()
        .trim()
        .split(":")
        .pop();
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = await new Promise((resolve) => {
            const request = get(url, (response) => {
                response.resume();
                resolve((response.statusCode ?? 500) < 400);
            });
            request.setTimeout(1000, () => request.destroy());
            request.on("error", () => resolve(false));
        });
        if (ready) return { name, url };
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const logs = execFileSync("docker", ["logs", name]).toString();
    spawnSync("docker", ["rm", "-f", name]);
    throw new Error(`frontend did not start:\n${logs}`);
};

export const stopFrontend = (frontend) => {
    if (frontend) spawnSync("docker", ["rm", "-f", frontend.name]);
};
