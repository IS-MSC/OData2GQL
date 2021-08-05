import {
	GraphQLString,
	GraphQLBoolean,
	GraphQLInt,
	GraphQLFloat,
} from "graphql";
import { Schema } from "./index";
import fs from "fs";

export const castTypesToGQL = (type: string) => {
	switch (type) {
		case "String":
			return GraphQLString;
		case "Boolean":
			return GraphQLBoolean;
		case "Int32":
		case "Int16":
			return GraphQLInt;
		case "Decimal":
			return GraphQLFloat;
		default:
			console.log(type);
			return GraphQLString;
	}
};

export const saveMetadata = (schema: Schema) => {
	fs.writeFile("./data/data.json", JSON.stringify(schema), () => {
		// console.log("Done!");
	});
};
