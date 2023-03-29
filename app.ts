import express, { Request, Response } from "express";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./utils/logger";
import * as url from "url";
const app = express();
const server = http.createServer(app);
const PORT = 1235;
app.use(express.json());

server.listen(PORT, () => {
	logger.info(`--------------------------------`);
	logger.info(`Server listening on port ${PORT}`);
	logger.info(`--------------------------------`);
});

const IMAGE_DIR: string = path.join(__dirname, "images");

let imageQueue: Image[] = [];
let images: Image[] = [];

interface ImageDetails {
	sourceUrl: string;
	storedUrl: string;
	addedAt: Date;
	completedAt?: Date;
}

interface Image {
	id: string;
	url: string;
	downloaded?: boolean;
	details: ImageDetails;
}

if (!fs.existsSync(IMAGE_DIR)) {
	fs.mkdirSync(IMAGE_DIR);
}

app.use("/images", express.static("images"));

app.get("/images", (_req: Request, res: Response) => {
	const details = images.map((image: Image): ImageDetails => image.details);
	res.send(details);
});

app.get("/images/:name", (req: Request, res: Response) => {
	const { name } = req.params;
	const foundImage = images.find((d: Image): boolean => d.id === name);
	const imageOnQueue = imageQueue.find((d: Image): boolean => d.id === name);
	if (typeof imageOnQueue === "object")
		return res.status(200).send({ message: "Image is on queue" });
	if (!foundImage && typeof imageOnQueue !== "object")
		return res.status(200).send({ message: "Image not found" });
	if (foundImage?.downloaded === true)
		return res.status(200).send({ message: "Image was downloaded" });
});

app.post("/images", async (req: Request, res: Response) => {
	const { url } = req.body;
	if (!url) return res.status(400).send({ message: "URL is required" });

	const id = uuidv4();
	const storedUrl: string = `${req.protocol}://${req.hostname}:${PORT}/images/${id}.jpg`;
	const checkImagePromise: Promise<number> = new Promise((resolve) => {
		checkImage(url, storedUrl, res);
		res.on("finish", () => {
			resolve(res.statusCode);
		});
	});
	const statusCode: number = await checkImagePromise;
	if (statusCode === 200)
		imageQueue = [
			...imageQueue,
			{
				id,
				url,
				downloaded: false,
				details: { sourceUrl: url, storedUrl, addedAt: new Date() },
			},
		];
});

const checkImage = async (
	imageUrl: string,
	storedUrl: string,
	res: Response
) => {
	const parsedUrl: url.UrlWithStringQuery = url.parse(imageUrl);
	if (parsedUrl.protocol === "https:")
		return https
			.get(imageUrl, (response: http.IncomingMessage): void => {
				const contentType: string | undefined =
					response.headers["content-type"];
				contentType && contentType.startsWith("image/")
					? res.status(200).send({ url: storedUrl.replace(".jpg", "") })
					: res
							.status(409)
							.send({ message: `Url doesn't contain image or it's not .jpg` });
			})
			.on("error", (err: Error) => {
				res.status(409).send({ message: err });
			});
	return res.status(409).send({ message: `Only https: supported` });
};

const downloadImage = (imageUrl: string, imagePath: string): Promise<void> => {
	return new Promise((resolve, reject) => {
		const file: fs.WriteStream = fs.createWriteStream(imagePath);
		const request: http.ClientRequest = https.get(
			imageUrl,
			(response: http.IncomingMessage) => {
				if (response.statusCode !== 200) {
					reject(`Failed to download image: HTTP ${response.statusCode}`);
					return;
				}
				response.pipe(file);
				file.on("finish", () => {
					file.close();
					resolve();
				});

				response.on("error", (err: Error) => {
					fs.unlink(imagePath, () => reject(err));
				});
				file.on("error", (err: Error) => {
					fs.unlink(imagePath, () => reject(err));
				});
			}
		);
		request.on("error", (err: Error) => {
			fs.unlink(imagePath, () => reject(err));
		});
	});
};

const processImageQueue = async (): Promise<void> => {
	const image: Image | undefined = imageQueue.shift();
	if (image) {
		try {
			const imagePath: string = path.join(IMAGE_DIR, `${image.id}.jpg`);
			await downloadImage(image.url, imagePath)
				.then((d) => logger.info("Downloaded"))
				.catch((err: Error) => logger.error(err));
			image.details.completedAt = new Date();
			image.downloaded = true;
			images = [...images, image];
		} catch (err) {
			logger.error(err);
		}
	}
};

setInterval(processImageQueue, 1000);
