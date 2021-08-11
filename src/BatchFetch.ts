export enum Method {
	GET = "GET",
	DELETE = "DELETE",
	POST = "POST",
	HEAD = "HEAD",
}

import fetch from "node-fetch";

interface Request {
	method: Method;
	url: string;
	contentType?: string;
	data?: any;
}

function getBoundary() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
		var r = (Math.random() * 16) | 0,
			v = c == "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

let packChangingReqests = function (changeSet: Request[], token: string) {
	let body: string[] = [];
	let boundary = "changeset_" + getBoundary();

	body.push(`Content-Type: multipart/mixed; boundary=${boundary}`);
	body.push("");
	changeSet.forEach((request) => {
		let data = request.data ? JSON.stringify(request.data) : "";
		body.push("--" + boundary);
		body.push("Content-Type: application/http");
		body.push("Content-Transfer-Encoding: binary");
		body.push("");
		body.push(request.method + " " + request.url + " HTTP/1.1");
		body.push("Content-Type: " + (request.contentType || "application/json"));
		body.push("Content-Length: " + data.length);
		body.push("x-csrf-token: " + token);

		body.push(...SapHeaders);

		body.push("", data);
	});
	body.push("--" + boundary + "--");
	return body;
};

let SapHeaders = [
	"sap-contextid-accept: header",
	"Accept: application/json",
	"Accept-Language: ru-RU",
	"DataServiceVersion: 2.0",
	"MaxDataServiceVersion: 2.0",
];

let pack = function (data: Request[], boundary: string, token: string) {
	let changingRequests: Request[] = [];

	data = data.filter((e) => {
		let isChanging = !(e.method == Method.GET || e.method == Method.DELETE);
		if (isChanging) {
			changingRequests.push(e);
			return false;
		} else {
			return true;
		}
	});

	let body: string[] = [];

	body.push("--" + boundary);
	if (changingRequests.length > 0) {
		body.push(...packChangingReqests(changingRequests, token));
	}

	data.forEach((request: Request, i: number) => {
		body.push("--" + boundary);

		body.push("Content-Type: application/http");
		body.push("Content-Transfer-Encoding: binary");
		body.push("");
		body.push(request.method + " " + request.url + " HTTP/1.1");

		body.push(...SapHeaders);
		body.push("sap-cancel-on-close: true");
		body.push("", "");
	});

	body.push("", "--" + boundary + "--", "");

	return body.join("\r\n");
};

interface Response {
	status?: any;
	data?: any;
}

/**
 * Unpacks the given response and passes the unpacked data to the original callback.
 * @param {object} xhr jQuery XHR object.
 * @param {string} status Response status.
 * @param {Function} complete A callback to be executed upon unpacking the response.
 */
var unpack = function (text: string) {
	var lines = text.split("\r\n"),
		boundary = lines[0],
		data: any = [],
		d: Response | null = null;

	lines.forEach((l, i) => {
		if (l.length) {
			if (l.indexOf(boundary) == 0) {
				if (d) data.push(d);
				d = {};
			} else if (d) {
				if (!d.status) {
					d.status = parseInt(
						(function (m) {
							return m || [0, 0];
						})(/HTTP\/1.1 ([0-9]+)/g.exec(l))[1] as string,
						10
					);
				} else if (!d.data) {
					try {
						d.data = JSON.parse(l);
					} catch (ex) {}
				}
			}
		}
	});

	return data;
};

let csrf_token = null;
let token_promise: Promise<{ token: string; cookie: string }>;

export let getToken = async (url: string) => {
	if (!token_promise) {
		token_promise = new Promise((resolve, reject) => {
			fetch(url, {
				headers: {
					accept: "application/json",
					"accept-language": "ru-RU",
					"cache-control": "no-cache",
					"content-type": "application/json",
					dataserviceversion: "2.0",
					maxdataserviceversion: "2.0",
					pragma: "no-cache",
					"sap-cancel-on-close": "true",
					"sap-contextid-accept": "header",
					"sec-ch-ua":
						'" Not A;Brand";v="99", "Chromium";v="90", "Google Chrome";v="90"',
					"sec-ch-ua-mobile": "?0",
					"sec-fetch-dest": "empty",
					"sec-fetch-mode": "cors",
					"sec-fetch-site": "same-origin",
					"x-csrf-token": "Fetch",
				},
				//@ts-ignore
				body: null,
				method: "HEAD",
				mode: "cors",
				// credentials: "same-origin",
				credentials: "include",
			}).then((res) => {
				let token = res.headers.get("x-csrf-token");
				let cookieRaw = res.headers.get("set-cookie");
				let cookie = cookieRaw
					?.split(", ")
					.map((s) => s.split("; ")[0])
					.join("; ");
				if (token == null) {
					reject("Failed to get csrf_token");
				}
				csrf_token = token as string;
				resolve({ token: token as string, cookie: cookie! });
			});
		});
	}
	return token_promise;
};

interface BatchOptions {
	url: string;
	data: Request[];
}

let fetchBatch = async function (params: BatchOptions): Promise<[number, any]> {
	return new Promise((resolve, reject) => {
		getToken(params.url).then((auth) => {
			var boundary = "batch_" + getBoundary();
			//   let boundary = "batch_199b-da94-b8a4";
			fetch(params.url + "$batch", {
				// credentials: "same-origin",
				//@ts-ignore
				credentials: "include",
				headers: {
					Accept: "multipart/mixed",
					"Content-type": "multipart/mixed;boundary=" + boundary,
					"x-csrf-token": auth.token,
					Cookie: auth.cookie,
				},
				method: "POST",
				body: pack(params.data, boundary, auth.token),
			}).then((res) => {
				let status = res.status;
				res.text().then((text) => {
					let data = unpack(text);

					resolve([status, data]);
				});
			});
		});
	});
};

export interface Abortable {
	abort: () => void;
	promise: Promise<[number, any]>;
}

export let abortableBatchFetch = function (params: BatchOptions): Abortable {
	const controller = new AbortController();
	const { signal } = controller;

	let promise = new Promise(
		(resolve: (value: [number, any]) => void, reject) => {
			getToken(params.url).then((auth) => {
				var boundary = "batch_" + getBoundary();
				//   let boundary = "batch_199b-da94-b8a4";
				fetch(params.url + "$batch", {
					signal,
					// credentials: "same-origin",
					//@ts-ignore
					credentials: "include",
					headers: {
						Accept: "multipart/mixed",
						"Content-type": "multipart/mixed;boundary=" + boundary,
						"x-csrf-token": auth.token,
					},
					method: "POST",
					body: pack(params.data, boundary, auth.token),
				})
					.then((res) => {
						let status = res.status;
						res.text().then((text) => {
							let data = unpack(text);

							resolve([status, data]);
						});
					})
					.catch((err) => {
						if (err.name === "AbortError") {
							//console.log("Fetch aborted");
						} else {
							console.error("Uh oh, an error!", err);
							reject(err);
						}
					});
			});
		}
	);

	return {
		promise,
		abort: () => controller.abort(),
	};
};

// function getCookie(name) {
//   let token;
//   if (!document.cookie) {
//     token = null;

//     return token;
//   }

//   const xsrfCookies = document.cookie
//     .split(";")
//     .map((c) => c.trim())
//     .filter((c) => c.startsWith(name + "="));

//   if (xsrfCookies.length === 0) {
//     token = null;

//     return token;
//   }
//   token = decodeURIComponent(xsrfCookies[0].split("=")[1]);

//   return token;
// }

export let batchFetch = fetchBatch;
