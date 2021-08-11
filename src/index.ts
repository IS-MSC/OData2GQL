import parser from "xml-js";
import fetch from "node-fetch";
import fs from "fs";
import {
	graphql,
	GraphQLBoolean,
	GraphQLField,
	GraphQLFloat,
	GraphQLID,
	GraphQLInt,
	GraphQLList,
	GraphQLObjectType,
	GraphQLOutputType,
	GraphQLSchema,
	GraphQLString,
	GraphQLType,
	printSchema,
} from "graphql";
import { capitalize, castTypesToGQL, saveSchema, toArray } from "./helpers";
import express from "express";
import { graphqlHTTP } from "express-graphql";
import { ApolloServer } from "apollo-server-express";
import console from "console";
import merge from "lodash.merge";
import { createDataSource } from "./DataSource";
const serviceURL =
	"http://192.168.1.176:8080/sap/opu/odata/sap/ZPM_DL_MAIN_SRV/";
const serviceName = "ZPM_DL_MAIN_SRV";

const getMetadata = async () => {
	const metadata = await fetch(serviceURL + "/$metadata").then((response) =>
		response.text()
	);
	return metadata;
};

const getSchema = async () => {
	const metadata = parser.xml2js(await getMetadata(), {
		compact: true,
		ignoreDeclaration: true,
		// ignoreAttributes: true,
		elementNameFn: function (val) {
			return val.replace("edmx:", "");
		},
		attributeValueFn: (v) => {
			let tmp = v;
			if (v.includes("Edm.")) {
				tmp = v.replace("Edm.", "");
			}
			return tmp;
		},
		attributeNameFn: (v) => {
			let tmp = v;
			if (v.includes("sap:")) {
				tmp = v.replace("sap:", "");
			}
			return capitalize(tmp);
		},
	}) as any;
	const schema = metadata["Edmx"]["DataServices"]["Schema"] as Schema;
	return schema;
};

const main = async () => {
	const schema = await getSchema();
	saveSchema(schema);

	const associations = schema.Association.map(makeAssociation);

	const entities = schema.EntityType.map(makeEntity);
	const gqlQueries = entities.map(makeGQLQuery);
	gqlQueries.forEach((q) => {
		fs.writeFile(
			`./data/gql/${q.name}.gql`,
			printSchema(
				new GraphQLSchema({
					query: q.query,
				})
			),
			() => {
				// console.log("Done!");
			}
		);
	});
	const globalSchema = new GraphQLSchema({
		query: makeGlobalQuery(),
	});
	fs.writeFile(`./data/gql/${"global"}.gql`, printSchema(globalSchema), () => {
		// console.log("Done!");
	});
	var app = express();
	const server = new ApolloServer({
		schema: globalSchema,
		dataSources: () => {
			return {
				oData: new DataSource(),
			};
		},
	});
	await server.start();
	server.applyMiddleware({ app });

	app.listen({ port: 4000 }, () => {
		console.log("Server is ready at loсalhost:4000" + server.graphqlPath);
	});
	// console.log(entities);
};

const DataSource = createDataSource(serviceURL);
interface ResolverContext {
	dataSources: { oData: InstanceType<typeof DataSource> };
}

const makeNavigationResolver = (entity: Entity, field: string) => {
	const resolver = async (
		parent: any,
		params: any,
		context: ResolverContext
	) => {
		const query = entity.keys
			.map((key) => {
				return `${key}='${parent[key]}'`;
			})
			.join(",");
		const url = `${entity.name}Set(${query})/${field}`;
		// console.log(url);
		const response = await context.dataSources.oData.request(url);

		return response;
	};
	return resolver;
};

interface GQLField {
	type: GraphQLOutputType;
	description?: string;
	resolve?: (parent: any, params: any, context: any) => any;
}

interface FieldsMap {
	[index: string]: GQLField;
}

const makePropertiesFields = (entity: Entity) => {
	return entity.properties.reduce((accomulator, property) => {
		accomulator[property.name] = {
			type: property.name.includes("Id")
				? GraphQLID
				: castTypesToGQL(property.type),
			description: property.label,
		};
		if (property.name.includes("Id")) {
			const name = property.name.replace("Id", "");
			if (name !== entity.name && EntityMap[name] && EntityMap[name].gqlType) {
				accomulator[name] = {
					type: EntityMap[name].gqlType!,
					resolve: makeParentResolver(EntityMap[name].entity),
					description:
						property.label + " (" + EntityMap[name].entity.description + ")",
				};
			}
		}
		return accomulator;
	}, {} as FieldsMap);
};

const makeNavigationFields = (entity: Entity) => {
	return entity.navigation.reduce((accommulator, navigation) => {
		const gqlType = EntityMap[navigation.type].gqlType;
		if (!gqlType) {
			return accommulator;
		}
		accommulator[navigation.name] = {
			type: navigation.isSet ? new GraphQLList(gqlType) : gqlType,
			resolve: makeNavigationResolver(entity, navigation.name),
		};
		return accommulator;
	}, {} as FieldsMap);
};

const makeFieldMap = (entity: Entity) => {
	return () => {
		const PropertiesFields = makePropertiesFields(entity);
		const NavigationFields = makeNavigationFields(entity);
		const Metadata = metaDataField;

		return merge(NavigationFields, PropertiesFields, Metadata);
	};
};

const makeMetadataField = (): FieldsMap => {
	return {
		_metadata: {
			type: new GraphQLObjectType({
				name: "Metadata",
				fields: {
					id: {
						type: GraphQLString,
					},
					uri: {
						type: GraphQLString,
					},
					media_src: {
						type: GraphQLString,
					},
					edit_media: {
						type: GraphQLString,
					},
				},
			}),
			resolve: (parent: any) => {
				return parent.__metadata;
			},
		},
	};
};

const metaDataField = makeMetadataField();

const makeGQLType = (entity: Entity) => {
	const type = new GraphQLObjectType({
		name: entity.name,
		fields: makeFieldMap(entity),
		description: entity.description,
	});
	return type;
};
const makeKeysResolver = (entity: Entity) => {
	const resolver = async (_: any, params: any, context: ResolverContext) => {
		const query = entity.keys
			.map((key) => {
				return `${key}='${params[key]}'`;
			})
			.join(",");
		const response = await context.dataSources.oData.request(
			`${entity.name}Set(${query})`
		);
		return response;
	};
	return resolver;
};

const makeParentResolver = (entity: Entity) => {
	const resolver = async (
		parent: any,
		params: any,
		context: ResolverContext
	) => {
		const query = entity.keys
			.map((key) => {
				return `${key}='${parent[key]}'`;
			})
			.join(",");
		const response = await context.dataSources.oData.request(
			`${entity.name}Set(${query})`
		);

		return response;
	};
	return resolver;
};

const makeSetResolver = (entity: Entity) => {
	const resolver = async (_: any, params: any, context: ResolverContext) => {
		const query = [
			params["first"] ? `$top=${params["first"]}` : "",
			params["offset"] ? `$skip=${params["offset"]}` : "",
			params["substring"]
				? `$filter=substringof('${encodeURIComponent(
						params["substring"]
				  )}', DamageName)`
				: "",
		]
			.filter((v) => !!v)
			.join("&");
		const url = `${entity.name}Set&${query}`;
		console.log(url);
		const response = await context.dataSources.oData.request(url);

		return response;
	};
	return resolver;
};
const globalQueryFields: { [index: string]: any } = {};
const makeGQLQueryFields = (entity: Entity, type: GraphQLObjectType) => {
	const fields: { [index: string]: any } = {};
	const field = {
		type: type,
		description: entity.description,
		args: entity.keys.reduce((a, k) => {
			a[k] = {
				type: GraphQLID,
			};
			return a;
		}, {} as { [index: string]: any }),
		resolve: makeKeysResolver(entity),
	};
	const setField = {
		type: new GraphQLList(type),
		description: entity.description,
		args: ["first", "offset", "substring"].reduce((a, k) => {
			a[k] = {
				type: k === "substring" ? GraphQLString : GraphQLInt,
			};
			return a;
		}, {} as { [index: string]: any }),
		resolve: makeSetResolver(entity),
	};
	fields[entity.name] = field;
	fields[entity.name + "Set"] = setField;

	globalQueryFields[entity.name] = field;
	globalQueryFields[entity.name + "Set"] = setField;
	return fields;
};
const makeGlobalQuery = () => {
	const query = new GraphQLObjectType({
		name: "Query",
		fields: globalQueryFields,
	});
	return query;
};
const makeGQLQuery = (entity: Entity) => {
	const type = makeGQLType(entity);
	EntityMap[entity.name].gqlType = type;
	const fields = makeGQLQueryFields(entity, type);
	const query = new GraphQLObjectType({
		name: "Query",
		fields: fields,
	});
	return { query, name: entity.name };
};

const EntityMap: {
	[name: string]: {
		gqlType?: GraphQLObjectType;
		entity: Entity;
	};
} = {};

const makeEntity = (raw: ODataEntity): Entity => {
	const properties = toArray(raw.Property).map((p) => {
		return {
			name: p._attributes.Name,
			type: p._attributes.Type,
			nullable: false,
			label: p._attributes.Label || "",
		};
	});

	const keys = toArray(raw.Key.PropertyRef).map((e) => e._attributes.Name);
	const navigation =
		(raw.NavigationProperty &&
			toArray(raw.NavigationProperty).map((n) => {
				const association =
					AssociationMap[
						n._attributes.Relationship.replace(serviceName + ".", "")
					];
				return {
					name: n._attributes.Name.replace(serviceName + ".", ""),
					type: association.to,
					isSet: association.isSet,
				};
			})) ||
		[];

	const entity = {
		name: raw._attributes.Name,
		description: raw._attributes.Label || "",
		properties: properties,
		keys: keys,
		navigation,
	};
	EntityMap[raw._attributes.Name] = {
		entity,
	};
	return entity;
};

const AssociationMap: { [name: string]: Association } = {};
const makeAssociation = (raw: ODataAssociation): Association => {
	const toRaw = raw.End.find((e) =>
		e._attributes.Role.includes("ToRole_")
	)!._attributes;
	const to = toRaw.Type.replace(serviceName + ".", "");
	const isSet = toRaw.Multiplicity == "*";
	const association = {
		name: raw._attributes.Name,
		to,
		isSet,
	};
	AssociationMap[association.name] = association;
	return association;
};

interface Entity {
	name: string;
	description: string;
	properties: {
		name: string;
		type: string;
		nullable: boolean;

		label: string;
	}[];
	keys: string[];
	navigation: {
		name: string;
		type: string;
		isSet: boolean;
	}[];
}

interface Association {
	name: string;
	to: string;
	isSet: boolean;
}

interface ODataProperty {
	_attributes: {
		Name: string;

		Type: string;
		Nullable: boolean;
		MaxLength?: number;
		Label?: string;
	};
}
interface ODataEntity {
	_attributes: {
		Name: string;
		Label?: string;
	};
	Key: {
		PropertyRef:
			| { _attributes: { Name: string } }[]
			| { _attributes: { Name: string } };
	};
	Property: ODataProperty[] | ODataProperty;
	NavigationProperty?:
		| {
				_attributes: {
					Name: string;
					Relationship: string;
					FromRole: string;
					ToRole: string;
				};
		  }
		| {
				_attributes: {
					Name: string;
					Relationship: string;
					FromRole: string;
					ToRole: string;
				};
		  }[];
}

interface ODataAssociation {
	_attributes: {
		Name: string;
	};
	End: {
		_attributes: {
			Type: string;
			Multiplicity: "1" | "*";
			Role: string;
		};
	}[];
	ReferentialConstraint: {
		Principal: {
			_attributes: { Role: string };
			PropertyRef: { _attributes: { Name: string } };
		};
		Dependent: {
			_attributes: { Role: string };
			PropertyRef: { _attributes: { Name: string } };
		};
	};
}

export interface Schema {
	EntityType: ODataEntity[];
	Association: ODataAssociation[];
}
main();
