<?php
/**
 * Durable per-article mutual exclusion that works on MySQL, MariaDB and SQLite.
 *
 * The lock is one row in the options table. The table's UNIQUE option_name index makes
 * the insert atomic across PHP processes, so two concurrent deliveries of one article
 * cannot both create a post or attachment. Object caches are bypassed on purpose.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Lock {
	const PREFIX = 'r72pub_lock_';
	const TTL    = 120;

	private static function name( $key ) {
		return self::PREFIX . md5( $key );
	}

	/** @return array{name:string,value:string}|null */
	public static function acquire( $key, $wait_seconds = 8 ) {
		global $wpdb;
		$name     = self::name( $key );
		$deadline = microtime( true ) + $wait_seconds;
		do {
			$value = time() . '|' . wp_generate_uuid4();
			$prev  = $wpdb->suppress_errors( true );
			$ok    = $wpdb->insert(
				$wpdb->options,
				array(
					'option_name'  => $name,
					'option_value' => $value,
					'autoload'     => 'no',
				),
				array( '%s', '%s', '%s' )
			);
			$wpdb->suppress_errors( $prev );
			if ( $ok ) {
				wp_cache_delete( $name, 'options' );
				return array(
					'name'  => $name,
					'value' => $value,
				);
			}
			$held = self::held_value( $name );
			if ( null !== $held ) {
				$since = (int) strtok( $held, '|' );
				if ( $since > 0 && time() - $since > self::TTL ) {
					// A crashed request left the row behind: remove exactly that stale row.
					$wpdb->delete( $wpdb->options, array( 'option_name' => $name, 'option_value' => $held ), array( '%s', '%s' ) );
					continue;
				}
			}
			usleep( 150000 );
		} while ( microtime( true ) < $deadline );
		return null;
	}

	public static function release( $lock ) {
		global $wpdb;
		if ( is_array( $lock ) ) {
			$wpdb->delete( $wpdb->options, array( 'option_name' => $lock['name'], 'option_value' => $lock['value'] ), array( '%s', '%s' ) );
			wp_cache_delete( $lock['name'], 'options' );
		}
	}

	/** True while another request is writing this article (reconciliation must not report "absent"). */
	public static function is_held( $key ) {
		$held = self::held_value( self::name( $key ) );
		if ( null === $held ) {
			return false;
		}
		return time() - (int) strtok( $held, '|' ) <= self::TTL;
	}

	private static function held_value( $name ) {
		global $wpdb;
		$v = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name ) );
		return null === $v ? null : (string) $v;
	}

	public static function clear_all() {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( self::PREFIX ) . '%' ) );
	}
}
