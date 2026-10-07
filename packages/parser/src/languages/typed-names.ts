import type { Node } from 'web-tree-sitter';
import { typePath, type TypedName } from '../spec.js';

/** The type a TypeScript `type_annotation` field names, if it is a plain or generic name. */
function annotated(node: Node): string[] | null {
  const annotation = node.childForFieldName('type');
  return annotation?.type === 'type_annotation'
    ? typePath(annotation.namedChildren[0] ?? null)
    : null;
}

/** The class a `new` expression constructs. */
function constructed(value: Node | null): string[] | null {
  return value?.type === 'new_expression' ? typePath(value.childForFieldName('constructor')) : null;
}

const typed = (name: string | undefined, field: boolean, type: string[] | null): TypedName[] =>
  name && type ? [{ name, field, type }] : [];

/** Whether a parameter is also a class field (`constructor(private repo: Repo)`). */
const isParameterProperty = (node: Node): boolean =>
  node.children.some(
    (child) => child.type === 'accessibility_modifier' || child.type === 'readonly',
  );

/**
 * ECMAScript names with a stated type: `const r = new Rates()`, `let t: Tax`,
 * parameters `repo: Repo` (also fields when declared `private`/`readonly`),
 * class fields (`db: Db`, `cache = new Cache()`) and `this.log = new Logger()`.
 */
export const ecmascriptTypedNames: Readonly<Record<string, (node: Node) => readonly TypedName[]>> =
  {
    variable_declarator: (node) => {
      const name = node.childForFieldName('name');
      if (name?.type !== 'identifier') return [];
      return typed(
        name.text,
        false,
        constructed(node.childForFieldName('value')) ?? annotated(node),
      );
    },
    required_parameter: parameter,
    optional_parameter: parameter,
    public_field_definition: (node) =>
      typed(
        node.childForFieldName('name')?.text,
        true,
        annotated(node) ?? constructed(node.childForFieldName('value')),
      ),
    assignment_expression: (node) => {
      const left = node.childForFieldName('left');
      if (left?.type !== 'member_expression' || left.childForFieldName('object')?.type !== 'this') {
        return [];
      }
      return typed(
        left.childForFieldName('property')?.text,
        true,
        constructed(node.childForFieldName('right')),
      );
    },
  };

function parameter(node: Node): TypedName[] {
  const pattern = node.childForFieldName('pattern');
  if (pattern?.type !== 'identifier') return [];
  const type = annotated(node);
  return [
    ...typed(pattern.text, false, type),
    ...(isParameterProperty(node) ? typed(pattern.text, true, type) : []),
  ];
}

/**
 * A Python call that constructs a class by convention: its last name starts
 * with a capital (`Rates()`, `models.Rates()`). Whether it really is a class
 * is left to resolution, which only links to a definition that exists.
 */
function pythonConstructed(value: Node | null): string[] | null {
  if (value?.type !== 'call') return null;
  const path = typePath(value.childForFieldName('function'));
  return path && /^[A-Z]/.test(path.at(-1) ?? '') ? path : null;
}

const pythonType = (node: Node): string[] | null => {
  const type = node.childForFieldName('type');
  return type ? typePath(type.namedChildren[0] ?? null) : null;
};

/** Python names with a stated type: `repo: Repo` parameters, `r = Rates()`, `self.log = Logger()`. */
export const pythonTypedNames: Readonly<Record<string, (node: Node) => readonly TypedName[]>> = {
  typed_parameter: (node) => {
    const name = node.namedChildren.find((child) => child.type === 'identifier');
    return typed(name?.text, false, pythonType(node));
  },
  assignment: (node) => {
    const left = node.childForFieldName('left');
    const type = pythonType(node) ?? pythonConstructed(node.childForFieldName('right'));
    if (left?.type === 'identifier') return typed(left.text, false, type);
    const isSelfField =
      left?.type === 'attribute' &&
      left.childForFieldName('object')?.type === 'identifier' &&
      left.childForFieldName('object')?.text === 'self';
    return isSelfField ? typed(left.childForFieldName('attribute')?.text, true, type) : [];
  },
};

/** The type a declaration states, or the class a `new` creates when it says `var`. */
function declaredType(type: Node | null, value: Node | null | undefined): string[] | null {
  const stated =
    type && type.type !== 'implicit_type' && type.text !== 'var' ? typePath(type) : null;
  if (stated) return stated;
  return value?.type === 'object_creation_expression'
    ? typePath(value.childForFieldName('type'))
    : null;
}

/** Java: `Tax t = new Tax()`, `var v = new Vat()`, parameters `Rates r`, fields `Repo repo`. */
export const javaTypedNames: Readonly<Record<string, (node: Node) => readonly TypedName[]>> = {
  variable_declarator: (node) => {
    const declaration = node.parent;
    const field = declaration?.type === 'field_declaration';
    if (!declaration || (!field && declaration.type !== 'local_variable_declaration')) return [];
    return typed(
      node.childForFieldName('name')?.text,
      field,
      declaredType(declaration.childForFieldName('type'), node.childForFieldName('value')),
    );
  },
  formal_parameter: (node) =>
    typed(node.childForFieldName('name')?.text, false, typePath(node.childForFieldName('type'))),
};

/** C#: locals and fields (`Repo repo = new Repo()`, `var v = new Vat()`), parameters, properties. */
export const csharpTypedNames: Readonly<Record<string, (node: Node) => readonly TypedName[]>> = {
  variable_declaration: (node) => {
    const field = node.parent?.type === 'field_declaration';
    if (!field && node.parent?.type !== 'local_declaration_statement') return [];
    const type = node.childForFieldName('type');
    return node.namedChildren
      .filter((child) => child.type === 'variable_declarator')
      .flatMap((declarator) =>
        typed(
          declarator.childForFieldName('name')?.text,
          field,
          declaredType(
            type,
            declarator.namedChildren.find((child) => child.type === 'object_creation_expression'),
          ),
        ),
      );
  },
  parameter: (node) =>
    typed(node.childForFieldName('name')?.text, false, typePath(node.childForFieldName('type'))),
  property_declaration: (node) =>
    typed(node.childForFieldName('name')?.text, true, typePath(node.childForFieldName('type'))),
};

/** A Go composite literal's type (`Tax{}`, `&Vat{}`). */
function goLiteral(value: Node | null | undefined): string[] | null {
  const literal = value?.type === 'unary_expression' ? value.childForFieldName('operand') : value;
  return literal?.type === 'composite_literal' ? typePath(literal.childForFieldName('type')) : null;
}

/** Go: `t := Tax{}`, `u := &Vat{}`, `var w Worker`, parameters `r *Rates`, struct fields. */
export const goTypedNames: Readonly<Record<string, (node: Node) => readonly TypedName[]>> = {
  short_var_declaration: (node) => {
    const names = node.childForFieldName('left')?.namedChildren ?? [];
    const values = node.childForFieldName('right')?.namedChildren ?? [];
    return names.flatMap((name, index) =>
      name.type === 'identifier' ? typed(name.text, false, goLiteral(values[index])) : [],
    );
  },
  var_spec: (node) => {
    const type = typePath(node.childForFieldName('type'));
    return node.children
      .filter((child) => node.fieldNameForChild(node.children.indexOf(child)) === 'name')
      .flatMap((name) => typed(name.text, false, type));
  },
  parameter_declaration: (node) => {
    // A method's receiver is the object itself, already read as `self`.
    if (
      node.parent?.parent?.type === 'method_declaration' &&
      node.parent === node.parent.parent.childForFieldName('receiver')
    ) {
      return [];
    }
    const type = typePath(node.childForFieldName('type'));
    return node.children
      .filter((child) => child.type === 'identifier')
      .flatMap((name) => typed(name.text, false, type));
  },
  field_declaration: (node) => {
    if (node.parent?.type !== 'field_declaration_list') return [];
    const type = typePath(node.childForFieldName('type'));
    return node.children
      .filter((child) => child.type === 'field_identifier')
      .flatMap((name) => typed(name.text, true, type));
  },
};
